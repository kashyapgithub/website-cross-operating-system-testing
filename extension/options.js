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
const statusMessage = document.getElementById("status-message");

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
 * Persists the credentials and gives the user visual confirmation.
 * @param {SubmitEvent} event
 */
const handleSubmit = async (event) => {
  event.preventDefault();

  const githubPat = patInput.value.trim();
  const repoOwner = ownerInput.value.trim();
  const repoName = repoInput.value.trim();

  await chrome.storage.local.set({ githubPat, repoOwner, repoName });

  statusMessage.textContent = "Saved. You can close this tab and use the popup from now on.";
  statusMessage.style.color = "#4ade80";
};

form.addEventListener("submit", handleSubmit);
restoreSavedValues();
