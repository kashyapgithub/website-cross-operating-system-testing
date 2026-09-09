// -----------------------------------------------------------------------------
// popup.test.js
//
// Same approach as background.test.js: the REAL popup.js is executed via vm
// against a minimal fake DOM + chrome mock, and driven through its real init()
// and click handler — not reimplemented or refactored for testability.
//
// Run with: node --test popup.test.js
// -----------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = path.join(__dirname, "..", "extension", "popup.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

/** A minimal fake DOM element supporting exactly what popup.js actually touches. */
function makeElement(id) {
  const listeners = {};
  return {
    id,
    textContent: "",
    hidden: false,
    disabled: false,
    checked: true, // fullpage-toggle defaults checked, matches the real HTML
    dataset: {},
    onclick: null,
    removeAttribute(name) {
      delete this.dataset[name.replace(/^data-/, "")];
    },
    querySelector(selector) {
      // Only ever called for ".bench__state" / ".bench__thumb" within a slot in the real code.
      if (selector === ".bench__state") return this._stateEl || (this._stateEl = makeElement(`${id}-state`));
      if (selector === ".bench__thumb") return this._thumbEl || (this._thumbEl = makeElement(`${id}-thumb`));
      return null;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    _fire(type, payload) {
      listeners[type]?.(payload);
    },
  };
}

/**
 * Loads popup.js in a sandbox with a fake DOM/chrome, and returns the
 * elements + a way to fetch messages sent over the mocked port.
 */
function loadPopupScript({ activeTabUrl = "https://example.com", storedFullPage } = {}) {
  const elements = {
    "current-url": makeElement("current-url"),
    "run-btn": makeElement("run-btn"),
    "status-line": makeElement("status-line"),
    "settings-btn": makeElement("settings-btn"),
    "fullpage-toggle": makeElement("fullpage-toggle"),
    "fullpage-toggle-label": makeElement("fullpage-toggle-label"),
  };

  const slotElements = {
    windows: makeElement("slot-windows"),
    macos: makeElement("slot-macos"),
    linux: makeElement("slot-linux"),
  };

  const documentMock = {
    getElementById: (id) => elements[id],
    querySelector: (selector) => {
      const match = selector.match(/data-combo="(\w+)"/);
      return match ? slotElements[match[1]] : null;
    },
  };

  const connectCalls = [];
  let openOptionsPageCalls = 0;
  const storageSetCalls = [];
  let storedValue = storedFullPage;

  const chromeMock = {
    tabs: {
      query: async () => [{ url: activeTabUrl }],
    },
    storage: {
      local: {
        get: async (_keys) => (storedValue === undefined ? {} : { fullPage: storedValue }),
        set: async (obj) => {
          storageSetCalls.push(obj);
          if ("fullPage" in obj) storedValue = obj.fullPage;
        },
      },
    },
    runtime: {
      connect: (opts) => {
        const port = {
          messagesSent: [],
          onMessage: {
            listener: null,
            addListener(fn) {
              this.listener = fn;
            },
          },
          postMessage(msg) {
            this.messagesSent.push(msg);
          },
          disconnect() {},
        };
        connectCalls.push({ opts, port });
        return port;
      },
      openOptionsPage: () => {
        openOptionsPageCalls += 1;
      },
    },
  };

  const sandbox = {
    document: documentMock,
    chrome: chromeMock,
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "popup.js" });

  return {
    elements,
    slotElements,
    connectCalls,
    getOpenOptionsPageCalls: () => openOptionsPageCalls,
    getStorageSetCalls: () => storageSetCalls,
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------

test("rapid double-click on a valid page only opens ONE port connection (regression test for the double-click race)", async () => {
  const { elements, connectCalls } = loadPopupScript({ activeTabUrl: "https://example.com" });

  // init() reads the active tab URL asynchronously — let that settle first,
  // mirroring the real popup having finished loading before the user can click.
  await flushMicrotasks();

  // Fire two clicks back-to-back with no await in between, exactly like a
  // fast real double-click — the bug this test targets was a race where the
  // button didn't disable until after an internal await.
  elements["run-btn"]._fire("click");
  elements["run-btn"]._fire("click");

  await flushMicrotasks();

  assert.equal(connectCalls.length, 1, "a fast double-click must only trigger one GitHub Actions run");
});

test("clicking on a non-http page shows an error and does not open a port at all", async () => {
  const { elements, connectCalls } = loadPopupScript({ activeTabUrl: "chrome://extensions" });
  await flushMicrotasks();

  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  assert.equal(connectCalls.length, 0, "should never trigger a run for a non-testable page");
  assert.match(elements["status-line"].textContent, /testable web page/i);
});

test("after a run finishes, the button is re-enabled so a real second run can start", async () => {
  const { elements, connectCalls } = loadPopupScript();
  await flushMicrotasks();

  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  assert.equal(elements["run-btn"].disabled, true, "button should be disabled while a run is in flight");
  assert.equal(connectCalls.length, 1);

  // Simulate background.js reporting completion over the port.
  const { port } = connectCalls[0];
  port.onMessage.listener({ type: "RUN_FINISHED", timedOut: false });

  assert.equal(elements["run-btn"].disabled, false, "button must re-enable once the run reports finished");

  // And a genuine second click afterward should open a second, distinct run.
  elements["run-btn"]._fire("click");
  await flushMicrotasks();
  assert.equal(connectCalls.length, 2, "a second click after completion should start a new run");
});

test("full-page toggle: restores a previously saved choice on load", async () => {
  const { elements } = loadPopupScript({ storedFullPage: false });
  await flushMicrotasks();

  assert.equal(elements["fullpage-toggle"].checked, false, "should restore the saved 'off' choice, not default to on");
  assert.equal(elements["fullpage-toggle-label"].textContent, "Visible area only");
});

test("full-page toggle: saves the choice when changed (regression test for the persistence fix)", async () => {
  const { elements, getStorageSetCalls } = loadPopupScript({ storedFullPage: true });
  await flushMicrotasks();

  elements["fullpage-toggle"].checked = false;
  elements["fullpage-toggle"]._fire("change");

  const calls = getStorageSetCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fullPage, false, "toggling off must persist the new value, not just update the label");
});

test("settings button opens the options page", async () => {
  const { elements, getOpenOptionsPageCalls } = loadPopupScript();
  await flushMicrotasks();

  elements["settings-btn"]._fire("click");

  assert.equal(getOpenOptionsPageCalls(), 1);
});
