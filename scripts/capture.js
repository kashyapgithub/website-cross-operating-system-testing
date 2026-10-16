// -----------------------------------------------------------------------------
// capture.js
//
// A single, OS-agnostic script: it takes the target URL, output path, and
// capture mode from environment variables (set differently per-OS by the
// workflow) and produces one screenshot — full page or viewport-only,
// depending on what the extension's toggle sent. Any rendering differences
// between the resulting images across the matrix ARE the cross-OS visual
// differences you're checking for — same script, same browser engine,
// different real hardware.
// -----------------------------------------------------------------------------

const { chromium, firefox, webkit } = require("playwright");

const TARGET_URL = process.env.TARGET_URL;
const OUTPUT_PATH = process.env.OUTPUT_PATH ?? "screenshot-output.png";
const BROWSER_TYPE = (process.env.BROWSER || "chromium").toLowerCase();

const BROWSERS = { chromium, firefox, webkit };

// GitHub Actions passes booleans through client_payload as the strings
// "true"/"false" (JSON booleans get stringified for env vars), so this
// compares against the string explicitly rather than truthiness. Defaults
// to true (full page) if the value is missing for any reason.
const CAPTURE_FULL_PAGE = process.env.FULL_PAGE !== "false";

// A fixed viewport keeps screenshots comparable across OSes — otherwise a
// difference in default window size would look like a rendering bug.
const VIEWPORT = { width: 1440, height: 900 };

/** Guards against running with no target — fails loudly instead of silently. */
const assertTargetUrlProvided = () => {
  if (!TARGET_URL) {
    throw new Error("TARGET_URL environment variable is required.");
  }
};

/** Launches the specified browser, navigates to the target, and saves a screenshot. */
const captureScreenshot = async () => {
  const launcher = BROWSERS[BROWSER_TYPE];
  if (!launcher) {
    throw new Error(`Unsupported browser: "${BROWSER_TYPE}". Supported browsers: ${Object.keys(BROWSERS).join(", ")}`);
  }

  const browser = await launcher.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    // "networkidle" is deliberately avoided here: many real sites
    // (analytics beacons, websockets, ad pixels) never go network-idle, so
    // waiting on it throws a timeout instead of capturing anything. "load"
    // is the reliable baseline; the networkidle wait afterward is a
    // best-effort bonus that's allowed to time out silently.
    await page.goto(TARGET_URL, { waitUntil: "load", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.screenshot({ path: OUTPUT_PATH, fullPage: CAPTURE_FULL_PAGE });
  } finally {
    await browser.close();
  }
};

const main = async () => {
  assertTargetUrlProvided();
  await captureScreenshot();
  console.log(`Screenshot saved to ${OUTPUT_PATH}`);
};

main().catch((err) => {
  console.error("Capture failed:", err.message);
  process.exit(1);
});
