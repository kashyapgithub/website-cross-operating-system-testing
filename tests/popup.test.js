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
  const classes = new Set();
  const attributes = {};
  return {
    id,
    value: id === "repo-path-input" ? "docs/index.html" : "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: true, // fullpage-toggle defaults checked, matches the real HTML
    dataset: {},
    onclick: null,
    classList: {
      toggle(cls, force) {
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
      },
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    setAttribute(name, val) {
      attributes[name] = String(val);
    },
    getAttribute(name) {
      return attributes[name];
    },
    removeAttribute(name) {
      delete attributes[name];
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
function loadPopupScript({ activeTabUrl = "https://example.com", storedFullPage, storedBrowsers, storedTestMode, storedRepoPath } = {}) {
  const elements = {
    "current-url": makeElement("current-url"),
    "run-btn": makeElement("run-btn"),
    "status-line": makeElement("status-line"),
    "settings-btn": makeElement("settings-btn"),
    "setup-banner": makeElement("setup-banner"),
    "setup-banner-btn": makeElement("setup-banner-btn"),
    "mode-url-btn": makeElement("mode-url-btn"),
    "mode-repo-btn": makeElement("mode-repo-btn"),
    "panel-url": makeElement("panel-url"),
    "panel-repo": makeElement("panel-repo"),
    "repo-path-input": makeElement("repo-path-input"),
    "popout-btn": makeElement("popout-btn"),
    "expand-all-btn": makeElement("expand-all-btn"),
    "fullpage-toggle": makeElement("fullpage-toggle"),
    "fullpage-toggle-label": makeElement("fullpage-toggle-label"),
    "browser-chromium": makeElement("browser-chromium"),
    "browser-firefox": makeElement("browser-firefox"),
    "browser-webkit": makeElement("browser-webkit"),
    "lightbox-modal": makeElement("lightbox-modal"),
    "lightbox-backdrop": makeElement("lightbox-backdrop"),
    "lightbox-close": makeElement("lightbox-close"),
    "lightbox-title": makeElement("lightbox-title"),
    "lightbox-img": makeElement("lightbox-img"),
  };

  const slotElements = {
    windows: makeElement("slot-windows"),
    "windows-firefox": makeElement("slot-windows-firefox"),
    "windows-webkit": makeElement("slot-windows-webkit"),
    "macos-webkit": makeElement("slot-macos-webkit"),
    macos: makeElement("slot-macos"),
    "macos-firefox": makeElement("slot-macos-firefox"),
    linux: makeElement("slot-linux"),
    "linux-firefox": makeElement("slot-linux-firefox"),
    "linux-webkit": makeElement("slot-linux-webkit"),
  };

  const docListeners = {};
  const documentMock = {
    getElementById: (id) => elements[id],
    querySelector: (selector) => {
      const match = selector.match(/data-combo="([\w-]+)"/);
      return match ? slotElements[match[1]] : null;
    },
    addEventListener: (type, fn) => {
      docListeners[type] = fn;
    },
    _fire: (type, payload) => {
      docListeners[type]?.(payload);
    },
    body: {
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        contains(c) { return this.classes.has(c); },
      },
    },
  };

  const connectCalls = [];
  const tabCreateCalls = [];
  let openOptionsPageCalls = 0;
  const storageSetCalls = [];
  let storedValue = storedFullPage;
  let storedBrowsersValue = storedBrowsers;
  let storedTestModeValue = storedTestMode;
  let storedRepoPathValue = storedRepoPath;

  const chromeMock = {
    tabs: {
      query: async () => [{ url: activeTabUrl }],
      create: (opts) => {
        tabCreateCalls.push(opts);
      },
    },
    storage: {
      local: {
        get: async (_keys) => {
          const res = {};
          if (storedValue !== undefined) res.fullPage = storedValue;
          if (storedBrowsersValue !== undefined) res.selectedBrowsers = storedBrowsersValue;
          if (storedTestModeValue !== undefined) res.testMode = storedTestModeValue;
          if (storedRepoPathValue !== undefined) res.repoPath = storedRepoPathValue;
          return res;
        },
        set: async (obj) => {
          storageSetCalls.push(obj);
          if ("fullPage" in obj) storedValue = obj.fullPage;
          if ("selectedBrowsers" in obj) storedBrowsersValue = obj.selectedBrowsers;
          if ("testMode" in obj) storedTestModeValue = obj.testMode;
          if ("repoPath" in obj) storedRepoPathValue = obj.repoPath;
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
    documentMock,
    connectCalls,
    getTabCreateCalls: () => tabCreateCalls,
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

test("browser toggles: saves selected browsers when changed and sends them in START message", async () => {
  const { elements, connectCalls, getStorageSetCalls } = loadPopupScript();
  await flushMicrotasks();

  elements["browser-firefox"].checked = false;
  elements["browser-firefox"]._fire("change");

  const calls = getStorageSetCalls();
  const browserCall = calls.find((c) => "selectedBrowsers" in c);
  assert.ok(browserCall);
  assert.deepEqual([...browserCall.selectedBrowsers], ["chromium", "webkit"]);

  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  assert.equal(connectCalls.length, 1);
  const startMsg = connectCalls[0].port.messagesSent.find((m) => m.type === "START");
  assert.deepEqual([...startMsg.browsers], ["chromium", "webkit"]);
});

test("browser toggles: shows error and halts if all browsers are unchecked", async () => {
  const { elements, connectCalls } = loadPopupScript();
  await flushMicrotasks();

  elements["browser-chromium"].checked = false;
  elements["browser-firefox"].checked = false;
  elements["browser-webkit"].checked = false;

  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  assert.equal(connectCalls.length, 0, "should not connect when no browsers are selected");
  assert.match(elements["status-line"].textContent, /at least one browser/i);
});

test("popout button: opens popup.html in a new tab via chrome.tabs.create", async () => {
  const { elements, getTabCreateCalls } = loadPopupScript();
  await flushMicrotasks();

  elements["popout-btn"]._fire("click");

  const calls = getTabCreateCalls();
  assert.equal(calls.length, 1, "should call chrome.tabs.create once");
  assert.match(calls[0].url, /popup\.html\?tab=1/, "should pass tab=1 parameter");
});

test("expand all / collapse all: toggles all active thumbnails between expanded and compact", async () => {
  const { elements, slotElements } = loadPopupScript();
  await flushMicrotasks();

  assert.equal(elements["expand-all-btn"].textContent, "Expand all");

  // First click toggles all visible slots to expanded
  elements["expand-all-btn"]._fire("click");
  assert.equal(elements["expand-all-btn"].textContent, "Collapse all");
  assert.equal(slotElements.windows.querySelector(".bench__thumb").dataset.expanded, "true");

  // Second click collapses all slots back
  elements["expand-all-btn"]._fire("click");
  assert.equal(elements["expand-all-btn"].textContent, "Expand all");
  assert.equal(slotElements.windows.querySelector(".bench__thumb").dataset.expanded, undefined);
});

test("fullscreen lightbox modal: opens on thumbnail click and dismisses on close button or Escape", async () => {
  const { elements, slotElements, connectCalls, documentMock } = loadPopupScript();
  await flushMicrotasks();

  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  // Background reports COMBO_READY
  const { port } = connectCalls[0];
  port.onMessage.listener({
    type: "COMBO_READY",
    label: "Windows · Chrome",
    imageUrl: "data:image/png;base64,FAKEIMAGE123",
  });

  const thumb = slotElements.windows.querySelector(".bench__thumb");
  assert.equal(thumb.hidden, false);
  assert.equal(thumb.src, "data:image/png;base64,FAKEIMAGE123");

  // Lightbox should initially be hidden
  elements["lightbox-modal"].hidden = true;

  // Clicking thumbnail opens lightbox
  thumb.onclick();
  assert.equal(elements["lightbox-modal"].hidden, false);
  assert.equal(elements["lightbox-title"].textContent, "Windows · Chrome");
  assert.equal(elements["lightbox-img"].src, "data:image/png;base64,FAKEIMAGE123");

  // Clicking close button dismisses lightbox
  elements["lightbox-close"]._fire("click");
  assert.equal(elements["lightbox-modal"].hidden, true);

  // Clicking thumbnail opens it again
  thumb.onclick();
  assert.equal(elements["lightbox-modal"].hidden, false);

  // Pressing Escape dismisses lightbox
  documentMock._fire("keydown", { key: "Escape" });
  assert.equal(elements["lightbox-modal"].hidden, true);
});

test("setup banner: appears when credentials are missing and clicking configure opens options page", async () => {
  const { elements, getOpenOptionsPageCalls } = loadPopupScript();
  elements["setup-banner"].hidden = true;
  await flushMicrotasks();

  assert.equal(elements["setup-banner"].hidden, false, "setup banner should be visible when credentials missing");

  elements["setup-banner-btn"]._fire("click");
  assert.equal(getOpenOptionsPageCalls(), 1, "clicking configure should open options page");
});

test("mode switching: switches between URL and Repo modes, toggling panels and saving state", async () => {
  const { elements, getStorageSetCalls } = loadPopupScript();
  await flushMicrotasks();

  // Initially in URL mode
  assert.equal(elements["panel-url"].hidden, false);
  assert.equal(elements["panel-repo"].hidden, true);

  // Switch to Repo mode
  elements["mode-repo-btn"]._fire("click");
  assert.equal(elements["panel-url"].hidden, true);
  assert.equal(elements["panel-repo"].hidden, false);

  const calls = getStorageSetCalls();
  const modeCall = calls.find((c) => c.testMode === "repo");
  assert.ok(modeCall, "should persist testMode 'repo'");

  // Switch back to URL mode
  elements["mode-url-btn"]._fire("click");
  assert.equal(elements["panel-url"].hidden, false);
  assert.equal(elements["panel-repo"].hidden, true);
});

test("repo mode: dispatches testMode 'repo' and repoPath in START message even on non-http tab", async () => {
  const { elements, connectCalls } = loadPopupScript({ activeTabUrl: "chrome://newtab" });
  await flushMicrotasks();

  // Switch to repo mode
  elements["mode-repo-btn"]._fire("click");
  elements["repo-path-input"].value = "docs/index.html";

  // Clicking run test should succeed even though activeTabUrl is chrome://newtab!
  elements["run-btn"]._fire("click");
  await flushMicrotasks();

  assert.equal(connectCalls.length, 1, "should connect port successfully in repo mode");
  const startMsg = connectCalls[0].port.messagesSent.find((m) => m.type === "START");
  assert.ok(startMsg);
  assert.equal(startMsg.testMode, "repo");
  assert.equal(startMsg.repoPath, "docs/index.html");
});



