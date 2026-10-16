// -----------------------------------------------------------------------------
// background.test.js
//
// These are integration tests, not unit tests: the REAL background.js source
// is loaded and executed via Node's vm module inside a sandbox that mocks
// chrome.* and fetch. Nothing is refactored or exported for testability —
// the test drives the actual code through its real entry point
// (chrome.runtime.onConnect firing) exactly the way Chrome would, and
// observes exactly what it sends back over the port. This exercises
// triggerWorkflow, tryFetchScreenshot, arrayBufferToBase64, pollAndStream,
// and the disconnect-abort logic all together, as they actually run.
//
// Run with: node --test background.test.js
// -----------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = path.join(__dirname, "..", "extension", "background.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

/**
 * Builds a fresh sandboxed instance of background.js with mocked
 * chrome/fetch/Date, and returns test hooks to drive it.
 *
 * @param {object} opts
 * @param {object|null} opts.storedCredentials - what chrome.storage.local.get resolves to (null = none saved)
 * @param {(url: string, init: object) => Promise<{ok:boolean,status:number,arrayBuffer?:Function}>} opts.fetchImpl
 * @param {number} opts.clockStepMs - how far Date.now() advances on each call (lets tests fast-forward the 6-minute poll timeout without waiting for real time)
 */
function loadBackgroundScript({ storedCredentials, fetchImpl, clockStepMs = 1 }) {
  let onConnectHandler;
  const connectedPorts = [];

  // A minimal but faithful mock of chrome.runtime.Port + chrome.storage.local,
  // matching the exact API surface background.js actually calls.
  const chromeMock = {
    storage: {
      local: {
        get: async (_keys) => storedCredentials ?? {},
      },
    },
    runtime: {
      onConnect: {
        addListener: (handler) => {
          onConnectHandler = handler;
        },
      },
    },
  };

  // A controllable virtual clock. Real Date.now() would make the 6-minute
  // POLL_TIMEOUT_MS path genuinely take 6 minutes to test; advancing by a
  // large step per call lets the timeout test trip in a handful of calls.
  let virtualNow = Date.now();
  const DateMock = class extends Date {
    static now() {
      virtualNow += clockStepMs;
      return virtualNow;
    }
  };

  const sandbox = {
    chrome: chromeMock,
    fetch: fetchImpl,
    Date: DateMock,
    btoa: globalThis.btoa,
    Uint8Array: globalThis.Uint8Array,
    // Fires almost immediately regardless of requested delay, so the real
    // 10-second POLL_INTERVAL_MS doesn't make every test take real minutes.
    setTimeout: (fn) => setImmediate(fn),
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "background.js" });

  if (!onConnectHandler) {
    throw new Error("background.js never called chrome.runtime.onConnect.addListener — did the source change shape?");
  }

  /** Simulates the popup opening a port and clicking "Run test". */
  function simulateRun({ targetUrl = "https://example.com", fullPage = true, browsers } = {}) {
    const messages = [];
    let disconnectHandler = null;
    let isDisconnected = false;

    const port = {
      name: "cross-os-test",
      onMessage: {
        listener: null,
        addListener(fn) {
          this.listener = fn;
        },
      },
      onDisconnect: {
        addListener(fn) {
          disconnectHandler = fn;
        },
      },
      postMessage(msg) {
        if (isDisconnected) {
          throw new Error("Attempting to use a disconnected port object");
        }
        messages.push(msg);
      },
    };

    connectedPorts.push(port);
    onConnectHandler(port);
    port.onMessage.listener({ type: "START", targetUrl, fullPage, browsers });

    return {
      messages,
      /** Simulates the user closing the popup mid-run. */
      disconnect() {
        isDisconnected = true;
        disconnectHandler?.();
      },
    };
  }

  return { simulateRun };
}

/** Builds a minimal fake PNG-ish byte buffer of a given size for round-trip tests. */
function fakeImageBytes(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
  return bytes.buffer;
}

// ---------------------------------------------------------------------------

test("happy path: all three OSes stream in as COMBO_READY, then RUN_FINISHED(timedOut: false)", async () => {
  let contentsCallCount = 0;

  const { simulateRun } = loadBackgroundScript({
    storedCredentials: { githubPat: "pat", repoOwner: "kashyapgithub", repoName: "repo" },
    fetchImpl: async (url) => {
      if (url.includes("/dispatches")) {
        return { ok: true, status: 204 };
      }
      if (url.includes("/contents/")) {
        contentsCallCount += 1;
        // windows + linux ready on the very first poll, macos on the second —
        // mirrors real behavior where macOS runners lag behind.
        const isMacos = url.includes("macos-chromium.png");
        const ready = !isMacos || contentsCallCount > 3; // 3 combos checked per poll round
        if (!ready) return { ok: false, status: 404 };
        return { ok: true, status: 200, arrayBuffer: async () => fakeImageBytes(64) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const { messages } = simulateRun();
  // Let the microtask/immediate queue drain until we see the final message.
  await waitFor(() => messages.some((m) => m.type === "RUN_FINISHED"));

  const types = messages.map((m) => m.type);
  assert.deepEqual(types.slice(0, 1), ["TRIGGERED"]);
  assert.equal(messages.filter((m) => m.type === "COMBO_READY").length, 3);

  const labels = messages.filter((m) => m.type === "COMBO_READY").map((m) => m.label);
  assert.deepEqual(new Set(labels), new Set(["Windows · Chrome", "macOS · Chrome", "Linux · Chrome"]));

  const finished = messages.find((m) => m.type === "RUN_FINISHED");
  assert.equal(finished.timedOut, false);
});

test("missing credentials: reports ERROR without ever calling the GitHub API", async () => {
  let fetchWasCalled = false;

  const { simulateRun } = loadBackgroundScript({
    storedCredentials: {}, // no githubPat/repoOwner/repoName saved
    fetchImpl: async () => {
      fetchWasCalled = true;
      return { ok: true, status: 200 };
    },
  });

  const { messages } = simulateRun();
  await waitFor(() => messages.length > 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "ERROR");
  assert.equal(messages[0].error, "MISSING_CREDENTIALS");
  assert.equal(fetchWasCalled, false, "should fail fast before ever hitting the network");
});

test("dispatch rejected by GitHub (e.g. under-scoped PAT): reports ERROR and never starts polling", async () => {
  let contentsWasCalled = false;

  const { simulateRun } = loadBackgroundScript({
    storedCredentials: { githubPat: "pat", repoOwner: "o", repoName: "r" },
    fetchImpl: async (url) => {
      if (url.includes("/dispatches")) return { ok: false, status: 403 };
      contentsWasCalled = true;
      return { ok: false, status: 404 };
    },
  });

  const { messages } = simulateRun();
  await waitFor(() => messages.some((m) => m.type === "ERROR"));

  const error = messages.find((m) => m.type === "ERROR");
  assert.match(error.error, /403/);
  assert.equal(contentsWasCalled, false, "should not poll for screenshots after a failed trigger");
});

test("timeout path: reports RUN_FINISHED(timedOut: true) if screenshots never appear, without throwing", async () => {
  const { simulateRun } = loadBackgroundScript({
    storedCredentials: { githubPat: "pat", repoOwner: "o", repoName: "r" },
    fetchImpl: async (url) => {
      if (url.includes("/dispatches")) return { ok: true, status: 204 };
      return { ok: false, status: 404 }; // never ready
    },
    clockStepMs: 70_000, // jumps the virtual clock past the 6-minute deadline in a handful of calls
  });

  const { messages } = simulateRun();
  await waitFor(() => messages.some((m) => m.type === "RUN_FINISHED"));

  const finished = messages.find((m) => m.type === "RUN_FINISHED");
  assert.equal(finished.timedOut, true);
  assert.equal(messages.some((m) => m.type === "COMBO_READY"), false);
});

test("popup disconnect mid-run: stops cleanly, never throws, never sends another message after disconnect", async () => {
  let disconnectFn;

  const { simulateRun } = loadBackgroundScript({
    storedCredentials: { githubPat: "pat", repoOwner: "o", repoName: "r" },
    fetchImpl: async (url) => {
      if (url.includes("/dispatches")) return { ok: true, status: 204 };
      if (url.includes("/contents/")) {
        // Simulate the popup closing WHILE the first poll's fetches are in flight.
        disconnectFn?.();
        return { ok: false, status: 404 };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const run = simulateRun();
  disconnectFn = run.disconnect;

  // Give the poll loop a few ticks to (not) do anything after disconnect.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const typesAfter = run.messages.map((m) => m.type);
  assert.ok(typesAfter.includes("TRIGGERED"));
  assert.equal(typesAfter.includes("RUN_FINISHED"), false, "must not post after the port disconnected");
  assert.equal(typesAfter.includes("COMBO_READY"), false, "must not post after the port disconnected");
});

test("arrayBufferToBase64 round-trips correctly across a chunk boundary (regression test for the chunking fix)", async () => {
  // 8192 is CHUNK_SIZE in background.js — deliberately testing sizes just
  // below, at, and above the boundary to catch off-by-one errors in the
  // chunked rewrite.
  const sizesToTest = [8191, 8192, 8193, 20_000];

  for (const size of sizesToTest) {
    const original = fakeImageBytes(size);
    let capturedDataUrl = null;

    const { simulateRun } = loadBackgroundScript({
      storedCredentials: { githubPat: "pat", repoOwner: "o", repoName: "r" },
      fetchImpl: async (url) => {
        if (url.includes("/dispatches")) return { ok: true, status: 204 };
        capturedDataUrl = "pending";
        return { ok: true, status: 200, arrayBuffer: async () => original };
      },
    });

    const { messages } = simulateRun();
    await waitFor(() => messages.some((m) => m.type === "COMBO_READY"));

    const dataUrl = messages.find((m) => m.type === "COMBO_READY").imageUrl;
    const base64 = dataUrl.replace("data:image/png;base64,", "");
    const decoded = Buffer.from(base64, "base64");

    assert.equal(decoded.length, size, `size ${size}: decoded length should match original`);
    assert.deepEqual(
      Uint8Array.from(decoded),
      new Uint8Array(original),
      `size ${size}: decoded bytes should exactly match the original buffer`
    );
  }
});

test("multi-browser path: streams all 9 combinations across Windows, macOS, and Linux", async () => {
  const { simulateRun } = loadBackgroundScript({
    storedCredentials: { githubPat: "pat", repoOwner: "kashyapgithub", repoName: "repo" },
    fetchImpl: async (url) => {
      if (url.includes("/dispatches")) {
        return { ok: true, status: 204 };
      }
      if (url.includes("/contents/")) {
        return { ok: true, status: 200, arrayBuffer: async () => fakeImageBytes(64) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const { messages } = simulateRun({ browsers: ["chromium", "firefox", "webkit"] });
  await waitFor(() => messages.some((m) => m.type === "RUN_FINISHED"));

  assert.equal(messages.filter((m) => m.type === "COMBO_READY").length, 9);
  const labels = messages.filter((m) => m.type === "COMBO_READY").map((m) => m.label);
  assert.ok(labels.includes("macOS · Safari"));
  assert.ok(labels.includes("Windows · Firefox"));
  assert.ok(labels.includes("Linux · WebKit"));
  assert.ok(labels.includes("Windows · Chrome"));

  const finished = messages.find((m) => m.type === "RUN_FINISHED");
  assert.equal(finished.timedOut, false);
});

// ---------------------------------------------------------------------------

/** Polls a condition until it's true or a generous timeout elapses. */
async function waitFor(conditionFn, timeoutMs = 2000) {
  const start = Date.now();
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
