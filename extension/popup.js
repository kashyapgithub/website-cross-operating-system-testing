// ---------------------------------------------------------------------------
// popup.js
//
// Thin UI layer only. All GitHub API calls live in background.js — the popup
// just asks the background worker to "run a test" and "check on a run",
// then renders whatever comes back. Keeping API logic out of the popup means
// a long-running poll survives the popup being closed and reopened.
// ---------------------------------------------------------------------------

const currentUrlEl = document.getElementById("current-url");
const runBtn = document.getElementById("run-btn");
const statusLine = document.getElementById("status-line");
const resultsGrid = document.getElementById("results-grid");
const settingsBtn = document.getElementById("settings-btn");

/** Reads the URL of the tab the popup was opened from. */
const getActiveTabUrl = async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.url ?? "";
};

/** Renders a single status line, replacing whatever was there before. */
const setStatus = (message) => {
  statusLine.textContent = message;
};

/**
 * Renders the screenshot grid from a list of { label, imageUrl } results.
 * @param {{ label: string, imageUrl: string }[]} results
 */
const renderResults = (results) => {
  resultsGrid.innerHTML = "";

  results.forEach(({ label, imageUrl }) => {
    const item = document.createElement("div");
    item.className = "results-grid__item";

    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = `Screenshot: ${label}`;

    const caption = document.createElement("p");
    caption.className = "results-grid__label";
    caption.textContent = label;

    item.append(img, caption);
    resultsGrid.append(item);
  });
};

/** Kicks off a run and polls until screenshots are ready or it fails. */
const handleRunClick = async () => {
  runBtn.disabled = true;
  resultsGrid.innerHTML = "";
  setStatus("Checking GitHub credentials…");

  const targetUrl = await getActiveTabUrl();

  const response = await chrome.runtime.sendMessage({
    type: "RUN_CROSS_OS_TEST",
    targetUrl,
  });

  if (response.error === "MISSING_CREDENTIALS") {
    setStatus("No GitHub token saved yet — opening setup…");
    chrome.runtime.openOptionsPage();
    runBtn.disabled = false;
    return;
  }

  if (response.error) {
    setStatus(`Failed: ${response.error}`);
    runBtn.disabled = false;
    return;
  }

  setStatus("Done ✓");
  renderResults(response.results);
  runBtn.disabled = false;
};

/** Wires up event listeners once the popup DOM is ready. */
const init = async () => {
  currentUrlEl.textContent = await getActiveTabUrl();
  runBtn.addEventListener("click", handleRunClick);
  settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
};

init();
