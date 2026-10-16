// -----------------------------------------------------------------------------
// options.test.js
//
// Tests for the options/setup page: pre-filling, token visibility toggle,
// live GitHub connection verification, and error handling.
// -----------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = path.join(__dirname, "..", "extension", "options.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

function makeElement(id) {
  const listeners = {};
  return {
    id,
    value: "",
    type: id === "pat-input" ? "password" : "text",
    textContent: "",
    disabled: false,
    dataset: {},
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    _fire(type, payload = {}) {
      listeners[type]?.(payload);
    },
  };
}

function loadOptionsScript({ storedCredentials = {}, fetchImpl = async () => ({ ok: true, status: 200 }) } = {}) {
  const elements = {
    "setup-form": makeElement("setup-form"),
    "pat-input": makeElement("pat-input"),
    "owner-input": makeElement("owner-input"),
    "repo-input": makeElement("repo-input"),
    "toggle-token-btn": makeElement("toggle-token-btn"),
    "save-btn": makeElement("save-btn"),
    "status-message": makeElement("status-message"),
  };

  const documentMock = {
    getElementById: (id) => elements[id],
  };

  const storageSetCalls = [];
  let storageValues = { ...storedCredentials };

  const chromeMock = {
    storage: {
      local: {
        get: async (keys) => {
          const res = {};
          keys.forEach((k) => {
            if (k in storageValues) res[k] = storageValues[k];
          });
          return res;
        },
        set: async (obj) => {
          storageSetCalls.push(obj);
          Object.assign(storageValues, obj);
        },
      },
    },
  };

  const sandbox = {
    document: documentMock,
    chrome: chromeMock,
    fetch: fetchImpl,
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "options.js" });

  return {
    elements,
    getStorageSetCalls: () => storageSetCalls,
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("restores previously saved credentials on load", async () => {
  const { elements } = loadOptionsScript({
    storedCredentials: {
      githubPat: "ghp_12345",
      repoOwner: "testuser",
      repoName: "testrepo",
    },
  });
  await flushMicrotasks();

  assert.equal(elements["pat-input"].value, "ghp_12345");
  assert.equal(elements["owner-input"].value, "testuser");
  assert.equal(elements["repo-input"].value, "testrepo");
});

test("toggle button switches token input between password and text", async () => {
  const { elements } = loadOptionsScript();
  await flushMicrotasks();

  assert.equal(elements["pat-input"].type, "password");

  // Click Show
  elements["toggle-token-btn"]._fire("click");
  assert.equal(elements["pat-input"].type, "text");
  assert.equal(elements["toggle-token-btn"].textContent, "Hide");

  // Click Hide
  elements["toggle-token-btn"]._fire("click");
  assert.equal(elements["pat-input"].type, "password");
  assert.equal(elements["toggle-token-btn"].textContent, "Show");
});

test("successful verification persists credentials and reports success", async () => {
  let fetchUrl = "";
  const { elements, getStorageSetCalls } = loadOptionsScript({
    fetchImpl: async (url) => {
      fetchUrl = url;
      return { ok: true, status: 200 };
    },
  });
  await flushMicrotasks();

  elements["pat-input"].value = "ghp_myvalidtoken";
  elements["owner-input"].value = "myorg";
  elements["repo-input"].value = "myrepo";

  elements["setup-form"]._fire("submit", { preventDefault() {} });
  await flushMicrotasks();

  assert.equal(fetchUrl, "https://api.github.com/repos/myorg/myrepo");
  const calls = getStorageSetCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0] }, {
    githubPat: "ghp_myvalidtoken",
    repoOwner: "myorg",
    repoName: "myrepo",
  });
  assert.equal(elements["status-message"].dataset.tone, "success");
  assert.match(elements["status-message"].textContent, /Verified & Connected/i);
});

test("handles 401 Unauthorized with clear guidance", async () => {
  const { elements, getStorageSetCalls } = loadOptionsScript({
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await flushMicrotasks();

  elements["pat-input"].value = "ghp_badtoken";
  elements["owner-input"].value = "myorg";
  elements["repo-input"].value = "myrepo";

  elements["setup-form"]._fire("submit", { preventDefault() {} });
  await flushMicrotasks();

  assert.equal(getStorageSetCalls().length, 0, "should not save invalid token on 401");
  assert.equal(elements["status-message"].dataset.tone, "error");
  assert.match(elements["status-message"].textContent, /401 Unauthorized/i);
});

test("handles 404 Not Found for non-existent repo", async () => {
  const { elements, getStorageSetCalls } = loadOptionsScript({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await flushMicrotasks();

  elements["pat-input"].value = "ghp_token";
  elements["owner-input"].value = "wronguser";
  elements["repo-input"].value = "wrongrepo";

  elements["setup-form"]._fire("submit", { preventDefault() {} });
  await flushMicrotasks();

  assert.equal(getStorageSetCalls().length, 0, "should not save on 404");
  assert.equal(elements["status-message"].dataset.tone, "error");
  assert.match(elements["status-message"].textContent, /404 Not Found/i);
});
