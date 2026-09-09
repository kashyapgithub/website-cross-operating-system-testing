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

const slotByLabel = {
  "Windows · Chrome": document.querySelector('[data-combo="windows"]'),
  "macOS · Chrome": document.querySelector('[data-combo="macos"]'),
  "Linux · Chrome": document.querySelector('[data-combo="linux"]'),
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
  stateEl.dataset.state = state;
  stateEl.textContent = label;
  slot.dataset.active = state === "running";
};

const resetBench = () => {
  Object.values(slotByLabel).forEach((slot) => {
    setSlotState(slot, "queued", "Queued");
    const thumb = slot.querySelector(".bench__thumb");
    thumb.hidden = true;
    thumb.removeAttribute("data-expanded");
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
  thumb.src = imageUrl;
  thumb.hidden = false;
  thumb.onclick = () => toggleExpand(thumb);
};

const handleRunClick = async () => {
  const targetUrl = await getActiveTabUrl();

  if (!/^https?:\/\//.test(targetUrl)) {
    setStatus("This isn't a testable web page — open a real http(s) site first.", "error");
    return;
  }

  runBtn.disabled = true;
  resetBench();
  setStatus("Starting run…");

  const port = chrome.runtime.connect({ name: "cross-os-test" });

  port.onMessage.addListener((message) => {
    if (message.type === "TRIGGERED") {
      setStatus("Workflow triggered — waiting for runners to spin up…");
      Object.values(slotByLabel).forEach((slot) => setSlotState(slot, "running", "Running…"));
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

  port.postMessage({ type: "START", targetUrl, fullPage: fullPageToggle.checked });
};

const init = async () => {
  currentUrlEl.textContent = await getActiveTabUrl();
  runBtn.addEventListener("click", handleRunClick);
  settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  fullPageToggle.addEventListener("change", () => {
    fullPageToggleLabel.textContent = fullPageToggle.checked ? "Full page" : "Visible area only";
  });
};

init();
