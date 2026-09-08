# Cross-OS Page Tester

Free cross-OS visual testing: a Chrome extension triggers a GitHub Actions
workflow that screenshots a page on real Windows, macOS, and Linux runners,
and the extension displays the results.

## How it fits together

```
[Popup: "Test this page"]
        │
        ▼
[background.js] --POST--> [GitHub repository_dispatch API]
        │                          │
        │                          ▼
        │                 [Actions workflow: 3 OS runners in parallel]
        │                          │
        │                          ▼
        │                 [Playwright screenshots each OS]
        │                          │
        │                          ▼
        │                 [Committed to `results` branch]
        │
        ▼ (polls every 10s)
[GitHub Contents API] --returns image bytes--> [Popup renders grid]
```

## One-time setup

### 1. Create the GitHub repo
Push this folder to a new repo (public or private — both work, since the
extension authenticates with a token either way).

### 2. Create an empty `results` branch
The workflow commits screenshots here, kept separate from your main branch
so screenshot history doesn't clutter your commits.

```bash
git checkout --orphan results
git rm -rf .
git commit --allow-empty -m "Initial empty results branch"
git push origin results
git checkout main
```

### 3. Generate a Personal Access Token
Go to **github.com/settings/tokens?type=beta** → *Generate new token*
(fine-grained). Scope it to **only this repo**, with:
- **Actions**: Read and write
- **Contents**: Read and write

### 4. Load the extension
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Click the extension icon once — it'll prompt you to the setup page
   automatically the first time there's no saved token
5. Paste your token, repo owner, and repo name — saved forever after this

## Using it
Open any page, click the extension icon, click **Test this page**. Expect
1–4 minutes (macOS runners are the slow part to spin up). Results appear as
a small grid of screenshots labeled by OS.

## Extending it
- **Add more browsers per OS**: edit `TEST_COMBINATIONS` in `background.js`
  and the matrix step in `capture.js`'s browser install line — Playwright
  supports `firefox` and `webkit` the same way as `chromium`.
- **Keep history**: point a Supabase table at the `results` branch contents
  instead of just showing the latest run.
- **Reduce Actions minutes usage**: macOS runners cost 10x your quota vs
  Linux — drop `macos-latest` from the matrix if you mostly care about
  Windows vs Linux differences.

## Known limitations (be aware, not surprised)
- WebKit-on-Linux approximates Safari's engine but isn't pixel-identical to
  real macOS Safari — good for layout bugs, not font-hinting nitpicks.
- The popup's poll can take a few minutes; closing the popup mid-run is
  fine, the background service worker keeps polling, but MV3 service
  workers can be killed by Chrome if idle too long between fetches — if a
  run seems stuck, reopening the popup and clicking "Test this page" again
  is the simplest recovery.
- A leaked PAT (even repo-scoped) lets someone trigger workflow runs on
  your account — don't commit it, don't share the extension's storage.
