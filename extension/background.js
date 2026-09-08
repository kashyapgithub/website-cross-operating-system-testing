// ---------------------------------------------------------------------------
// background.js (MV3 service worker)
//
// Responsibilities:
//   1. Read saved GitHub credentials from chrome.storage.local.
//   2. Fire a `repository_dispatch` event to kick off the Actions workflow.
//   3. Poll the repo's `results` branch until the expected screenshots exist.
//   4. Fetch each screenshot (via the Contents API, so it works on private
//      repos too) and hand back blob URLs for the popup to render.
//
// Kept separate from popup.js on purpose: a poll can run for a few minutes
// (macOS runners are slow to start), and doing the work here means it keeps
// going even if the user closes the popup and reopens it later.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

// Each entry becomes one screenshot job in the Actions matrix.
// Add more browsers per OS here if you want engine-level comparisons too —
// just keep in mind macOS/Windows runners consume Actions minutes faster.
const TEST_COMBINATIONS = [
  { os: "windows", browser: "chromium", label: "Windows · Chrome" },
  { os: "macos", browser: "chromium", label: "macOS · Chrome" },
  { os: "linux", browser: "chromium", label: "Linux · Chrome" },
];

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000; // macOS runners are the slow part

/** Reads saved credentials; returns null if setup hasn't happened yet. */
const getCredentials = async () => {
  const { githubPat, repoOwner, repoName } = await chrome.storage.local.get([
    "githubPat",
    "repoOwner",
    "repoName",
  ]);

  const hasAllFields = Boolean(githubPat && repoOwner && repoName);
  return hasAllFields ? { githubPat, repoOwner, repoName } : null;
};

/** Fires the repository_dispatch event that starts the Actions workflow. */
const triggerWorkflow = async ({ githubPat, repoOwner, repoName }, targetUrl, runTag) => {
  const response = await fetch(`${GITHUB_API}/repos/${repoOwner}/${repoName}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubPat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "cross-os-test",
      client_payload: { target_url: targetUrl, run_tag: runTag },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub rejected the trigger (${response.status})`);
  }
};

/**
 * Attempts to fetch one screenshot from the `results` branch via the
 * Contents API. Returns a blob URL on success, or null if it's not
 * uploaded yet (404 is expected while the workflow is still running).
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

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

/** Sleeps for the given number of milliseconds. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls every combination's expected screenshot path until all are found
 * or the timeout is hit. Returns whatever was successfully collected.
 */
const pollForScreenshots = async (credentials, runTag) => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const found = new Map();

  while (Date.now() < deadline && found.size < TEST_COMBINATIONS.length) {
    const pending = TEST_COMBINATIONS.filter((combo) => !found.has(combo.label));

    await Promise.all(
      pending.map(async (combo) => {
        const path = `results/${runTag}/${combo.os}-${combo.browser}.png`;
        const imageUrl = await tryFetchScreenshot(credentials, path);
        if (imageUrl) found.set(combo.label, imageUrl);
      })
    );

    if (found.size < TEST_COMBINATIONS.length) await wait(POLL_INTERVAL_MS);
  }

  return Array.from(found, ([label, imageUrl]) => ({ label, imageUrl }));
};

/** End-to-end handler for a "run a test" request from the popup. */
const runCrossOsTest = async (targetUrl) => {
  const credentials = await getCredentials();
  if (!credentials) return { error: "MISSING_CREDENTIALS" };

  const runTag = `run-${Date.now()}`;

  try {
    await triggerWorkflow(credentials, targetUrl, runTag);
    const results = await pollForScreenshots(credentials, runTag);

    if (results.length === 0) {
      return { error: "Timed out waiting for screenshots — check the Actions tab on GitHub." };
    }

    return { results };
  } catch (err) {
    return { error: err.message };
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_CROSS_OS_TEST") return false;

  runCrossOsTest(message.targetUrl).then(sendResponse);
  return true; // keep the message channel open for the async response
});
