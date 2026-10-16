// ---------------------------------------------------------------------------
// popup.js
//
// Thin UI layer only — all GitHub API work lives in background.js. Opens a
// long-lived port and updates each bench slot as COMBO_READY messages
// stream in, so each OS's status updates independently.
// ---------------------------------------------------------------------------

const currentUrlEl = document.getElementById("current-url");
const runBtn = document.getElementById("run-btn");
const statusLine = document.getElementById("status-line");
const settingsBtn = document.getElementById("settings-btn");
const fullPageToggle = document.getElementById("fullpage-toggle");
const fullPageToggleLabel = document.getElementById("fullpage-toggle-label");

const browserCheckboxes = {
  chromium: document.getElementById("browser-chromium"),
  firefox: document.getElementById("browser-firefox"),
  webkit: document.getElementById("browser-webkit"),
};

const slotByLabel = {
  "Windows · Chrome": document.querySelector('[data-combo="windows"]'),
  "Windows · Firefox": document.querySelector('[data-combo="windows-firefox"]'),
  "Windows · WebKit": document.querySelector('[data-combo="windows-webkit"]'),
  "macOS · Safari": document.querySelector('[data-combo="macos-webkit"]'),
  "macOS · Chrome": document.querySelector('[data-combo="macos"]'),
  "macOS · Firefox": document.querySelector('[data-combo="macos-firefox"]'),
  "Linux · Chrome": document.querySelector('[data-combo="linux"]'),
  "Linux · Firefox": document.querySelector('[data-combo="linux-firefox"]'),
  "Linux · WebKit": document.querySelector('[data-combo="linux-webkit"]'),
};

const comboBrowser = {
  "Windows · Chrome": "chromium",
  "Windows · Firefox": "firefox",
  "Windows · WebKit": "webkit",
  "macOS · Safari": "webkit",
  "macOS · Chrome": "chromium",
  "macOS · Firefox": "firefox",
  "Linux · Chrome": "chromium",
  "Linux · Firefox": "firefox",
  "Linux · WebKit": "webkit",
};

const getActiveTabUrl = async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.url ?? "";
};

const setStatus = (message, tone = "normal") => {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
};

const setSlotState = (slot, state, label) => {
  const stateEl = slot.querySelector(".bench__state");
  if (stateEl) {
    stateEl.dataset.state = state;
    stateEl.textContent = label;
  }
  slot.dataset.active = state === "running";
};

const getSelectedBrowsers = () => {
  const selected = [];
  if (browserCheckboxes.chromium?.checked) selected.push("chromium");
  if (browserCheckboxes.firefox?.checked) selected.push("firefox");
  if (browserCheckboxes.webkit?.checked) selected.push("webkit");

  if (selected.length === 0 && !browserCheckboxes.chromium && !browserCheckboxes.firefox && !browserCheckboxes.webkit) {
    return ["chromium"];
  }

  return selected;
};

const updateSlotVisibility = () => {
  const selected = new Set(getSelectedBrowsers());
  Object.entries(slotByLabel).forEach(([label, slot]) => {
    if (!slot) return;
    const browser = comboBrowser[label];
    slot.hidden = !selected.has(browser);
  });
};

const resetBench = () => {
  const selected = new Set(getSelectedBrowsers());
  Object.entries(slotByLabel).forEach(([label, slot]) => {
    if (!slot) return;
    const browser = comboBrowser[label];
    if (selected.has(browser) || !selected.size) {
      setSlotState(slot, "queued", "Queued");
      const thumb = slot.querySelector(".bench__thumb");
      if (thumb) {
        thumb.hidden = true;
        thumb.removeAttribute("data-expanded");
      }
    }
  });
};

const toggleExpand = (thumb) => {
  const isExpanded = thumb.dataset.expanded === "true";
  thumb.dataset.expanded = String(!isExpanded);
};

const markSlotDone = (label, imageUrl) => {
  const slot = slotByLabel[label];
  if (!slot) return;

  setSlotState(slot, "done", "Done");

  const thumb = slot.querySelector(".bench__thumb");
  if (thumb) {
    thumb.src = imageUrl;
    thumb.hidden = false;
    thumb.onclick = () => toggleExpand(thumb);
  }
};

const handleRunClick = async () => {
  // Disabled synchronously, before any await — an async function yields
  // control back to the browser at the first `await`, so a fast double-
  // click could otherwise invoke this handler a second time before the
  // first call ever reaches the line that disables the button, firing two
  // overlapping GitHub Actions runs from one click.
  if (runBtn.disabled) return;
  runBtn.disabled = true;

  const targetUrl = await getActiveTabUrl();

  if (!/^https?:\/\//.test(targetUrl)) {
    setStatus("This isn't a testable web page — open a real http(s) site first.", "error");
    runBtn.disabled = false;
    return;
  }

  const selectedBrowsers = getSelectedBrowsers();
  if (selectedBrowsers.length === 0) {
    setStatus("Please select at least one browser to test.", "error");
    runBtn.disabled = false;
    return;
  }

  resetBench();
  setStatus("Starting run…");

  const port = chrome.runtime.connect({ name: "cross-os-test" });

  port.onMessage.addListener((message) => {
    if (message.type === "TRIGGERED") {
      setStatus("Workflow triggered — waiting for runners to spin up…");
      const selected = new Set(getSelectedBrowsers());
      Object.entries(slotByLabel).forEach(([label, slot]) => {
        if (!slot) return;
        const browser = comboBrowser[label];
        if (selected.has(browser) || !selected.size) {
          setSlotState(slot, "running", "Running…");
        }
      });
      return;
    }

    if (message.type === "COMBO_READY") {
      markSlotDone(message.label, message.imageUrl);
      return;
    }

    if (message.type === "RUN_FINISHED") {
      setStatus(message.timedOut ? "Some OSes timed out — check the Actions tab." : "All done ✓");
      runBtn.disabled = false;
      port.disconnect();
      return;
    }

    if (message.type === "ERROR") {
      if (message.error === "MISSING_CREDENTIALS") {
        setStatus("No GitHub token saved yet — opening setup…", "error");
        chrome.runtime.openOptionsPage();
      } else {
        setStatus(`Failed: ${message.error}`, "error");
      }
      runBtn.disabled = false;
      port.disconnect();
    }
  });

  port.postMessage({
    type: "START",
    targetUrl,
    fullPage: fullPageToggle ? fullPageToggle.checked : true,
    browsers: selectedBrowsers,
  });
};

const init = async () => {
  if (currentUrlEl) {
    currentUrlEl.textContent = await getActiveTabUrl();
  }
  runBtn?.addEventListener("click", handleRunClick);
  settingsBtn?.addEventListener("click", () => chrome.runtime.openOptionsPage());

  // Restore the last-used capture mode — without this, the toggle silently
  // resets to "Full page" every time the popup reopens, discarding a choice
  // the user just made.
  const { fullPage, selectedBrowsers } = await chrome.storage.local.get(["fullPage", "selectedBrowsers"]);
  if (fullPageToggle && fullPage !== undefined) {
    fullPageToggle.checked = fullPage;
    if (fullPageToggleLabel) {
      fullPageToggleLabel.textContent = fullPage ? "Full page" : "Visible area only";
    }
  }

  if (fullPageToggle) {
    fullPageToggle.addEventListener("change", () => {
      if (fullPageToggleLabel) {
        fullPageToggleLabel.textContent = fullPageToggle.checked ? "Full page" : "Visible area only";
      }
      chrome.storage.local.set({ fullPage: fullPageToggle.checked });
    });
  }

  if (selectedBrowsers && Array.isArray(selectedBrowsers)) {
    if (browserCheckboxes.chromium) browserCheckboxes.chromium.checked = selectedBrowsers.includes("chromium");
    if (browserCheckboxes.firefox) browserCheckboxes.firefox.checked = selectedBrowsers.includes("firefox");
    if (browserCheckboxes.webkit) browserCheckboxes.webkit.checked = selectedBrowsers.includes("webkit");
  }

  const saveBrowsers = () => {
    const browsers = getSelectedBrowsers();
    chrome.storage.local.set({ selectedBrowsers: browsers });
    updateSlotVisibility();
  };

  Object.values(browserCheckboxes).forEach((cb) => {
    cb?.addEventListener?.("change", saveBrowsers);
  });

  updateSlotVisibility();
};

init();
