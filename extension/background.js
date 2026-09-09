// ---------------------------------------------------------------------------
// background.js (MV3 service worker)
//
// Responsibilities:
//   1. Read saved GitHub credentials from chrome.storage.local.
//   2. Fire a `repository_dispatch` event to kick off the Actions workflow.
//   3. Poll the repo's `results` branch until each OS's screenshot exists.
//   4. Stream each result back to the popup AS IT ARRIVES over a long-lived
//      port, instead of waiting for all three and returning once — Windows
//      and Linux runners typically finish 2-3 minutes before macOS, and the
//      old all-or-nothing response hid that.
//
// Kept separate from popup.js on purpose: a poll can run for several
// minutes, and doing the work here means it keeps going even if the user
// closes the popup and reopens it later (the port just reconnects).
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

const TEST_COMBINATIONS = [
  { os: "windows", browser: "chromium", label: "Windows · Chrome" },
  { os: "macos", browser: "chromium", label: "macOS · Chrome" },
  { os: "linux", browser: "chromium", label: "Linux · Chrome" },
];

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

const getCredentials = async () => {
  const { githubPat, repoOwner, repoName } = await chrome.storage.local.get([
    "githubPat",
    "repoOwner",
    "repoName",
  ]);
  const hasAllFields = Boolean(githubPat && repoOwner && repoName);
  return hasAllFields ? { githubPat, repoOwner, repoName } : null;
};

const triggerWorkflow = async ({ githubPat, repoOwner, repoName }, targetUrl, runTag, fullPage) => {
  const response = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubPat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "cross-os-test",
      client_payload: { target_url: targetUrl, run_tag: runTag, full_page: fullPage },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub rejected the trigger (${response.status}). Check the PAT's permissions.`);
  }
};

/**
 * Deliberately returns a data: URL, not a blob: URL from
 * URL.createObjectURL(). Blob URLs are scoped to the execution context
 * that created them — a service worker and a popup are different contexts
 * in MV3, so a blob: URL made here would be dead on arrival in popup.js.
 */
const tryFetchScreenshot = async ({ githubPat, repoOwner, repoName }, path) => {
  const response = await fetch(
    `${GITHUB_API}/repos/${repoOwner}/${repoName}/contents/${path}?ref=results`,
    {
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: "application/vnd.github.raw",
      },
    }
  );

  if (!response.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  return `data:image/png;base64,${arrayBufferToBase64(arrayBuffer)}`;
};

const arrayBufferToBase64 = (arrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollAndStream = async (port, credentials, runTag, isAborted) => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const found = new Set();

  while (Date.now() < deadline && found.size < TEST_COMBINATIONS.length && !isAborted()) {
    const pending = TEST_COMBINATIONS.filter((combo) => !found.has(combo.label));

    await Promise.all(
      pending.map(async (combo) => {
        const path = `results/${runTag}/${combo.os}-${combo.browser}.png`;
        const imageUrl = await tryFetchScreenshot(credentials, path);
        if (!imageUrl || isAborted()) return;

        found.add(combo.label);
        port.postMessage({ type: "COMBO_READY", label: combo.label, imageUrl });
      })
    );

    if (found.size < TEST_COMBINATIONS.length && !isAborted()) await wait(POLL_INTERVAL_MS);
  }

  // Popup closed before we finished — nothing left to tell it, and posting
  // to a disconnected port would just throw. Stop quietly instead of
  // burning the rest of the 6-minute budget on API calls nobody's watching.
  if (isAborted()) return;

  const timedOut = found.size < TEST_COMBINATIONS.length;
  port.postMessage({ type: "RUN_FINISHED", timedOut });
};

const handleConnection = (port) => {
  let aborted = false;
  port.onDisconnect.addListener(() => {
    aborted = true;
  });

  port.onMessage.addListener(async (message) => {
    if (message.type !== "START") return;

    const credentials = await getCredentials();
    if (!credentials) {
      port.postMessage({ type: "ERROR", error: "MISSING_CREDENTIALS" });
      return;
    }

    const runTag = `run-${Date.now()}`;

    try {
      port.postMessage({ type: "TRIGGERED" });
      await triggerWorkflow(credentials, message.targetUrl, runTag, message.fullPage);
      await pollAndStream(port, credentials, runTag, () => aborted);
    } catch (err) {
      // The port may already be gone if the popup closed mid-request —
      // guard the error report itself so that case doesn't throw a second,
      // uglier error on top of the first.
      if (!aborted) {
        try {
          port.postMessage({ type: "ERROR", error: err.message });
        } catch {
          // Port died between the abort flag and this call — nothing to do.
        }
      }
    }
  });
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "cross-os-test") handleConnection(port);
});
