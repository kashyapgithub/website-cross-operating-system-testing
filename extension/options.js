// ---------------------------------------------------------------------------
// options.js
//
// Handles the one-time GitHub credentials form. Once saved, the token/owner/
// repo live in chrome.storage.local and background.js reads them for every
// future API call — the user never has to re-enter them.
// ---------------------------------------------------------------------------

const form = document.getElementById("setup-form");
const patInput = document.getElementById("pat-input");
const ownerInput = document.getElementById("owner-input");
const repoInput = document.getElementById("repo-input");
const toggleTokenBtn = document.getElementById("toggle-token-btn");
const saveBtn = document.getElementById("save-btn");
const statusMessage = document.getElementById("status-message");

const setStatus = (msg, tone = "") => {
  if (!statusMessage) return;
  statusMessage.textContent = msg;
  statusMessage.dataset.tone = tone;
};

/**
 * Pre-fill the form if credentials were already saved, so revisiting the
 * options page doesn't look like a blank slate.
 */
const restoreSavedValues = async () => {
  const saved = await chrome.storage.local.get(["githubPat", "repoOwner", "repoName"]);

  if (saved.githubPat) patInput.value = saved.githubPat;
  if (saved.repoOwner) ownerInput.value = saved.repoOwner;
  if (saved.repoName) repoInput.value = saved.repoName;
};

/**
 * Toggle visibility of PAT input.
 */
toggleTokenBtn?.addEventListener("click", () => {
  if (patInput.type === "password") {
    patInput.type = "text";
    toggleTokenBtn.textContent = "Hide";
  } else {
    patInput.type = "password";
    toggleTokenBtn.textContent = "Show";
  }
});

/**
 * Validates the credentials against GitHub API before saving.
 * @param {SubmitEvent} event
 */
const handleSubmit = async (event) => {
  event.preventDefault();

  const githubPat = patInput.value.trim();
  const repoOwner = ownerInput.value.trim();
  const repoName = repoInput.value.trim();

  if (!githubPat || !repoOwner || !repoName) {
    setStatus("Please fill in all three fields.", "error");
    return;
  }

  saveBtn.disabled = true;
  setStatus("Testing connection to GitHub repository…", "loading");

  try {
    const res = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (res.ok) {
      await chrome.storage.local.set({ githubPat, repoOwner, repoName });
      setStatus(`✓ Verified & Connected! Repository "${repoOwner}/${repoName}" is ready. You can close this tab and start testing pages.`, "success");
    } else if (res.status === 401) {
      setStatus("❌ 401 Unauthorized: GitHub rejected this token. Please check that you copied the token completely with no extra characters.", "error");
    } else if (res.status === 404) {
      setStatus(`❌ 404 Not Found: Repository "${repoOwner}/${repoName}" could not be found. Check for typos in your username or repo name, and ensure the token has access.`, "error");
    } else if (res.status === 403) {
      setStatus("❌ 403 Forbidden: Permission denied or rate limited. Ensure token has 'repo' or 'Actions: Read & write' and 'Contents: Read & write'.", "error");
    } else {
      setStatus(`❌ GitHub API responded with status ${res.status}.`, "error");
    }
  } catch (err) {
    // If user is offline, save anyway
    await chrome.storage.local.set({ githubPat, repoOwner, repoName });
    setStatus(`⚠️ Saved locally, but could not reach GitHub network to verify: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
  }
};

form.addEventListener("submit", handleSubmit);
restoreSavedValues();

