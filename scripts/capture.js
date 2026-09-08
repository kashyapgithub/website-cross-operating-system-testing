// -----------------------------------------------------------------------------
// capture.js
//
// A single, OS-agnostic script: it takes the target URL and output path from
// environment variables (set differently per-OS by the workflow) and produces
// one full-page screenshot. Any rendering differences between the resulting
// images across the matrix ARE the cross-OS visual differences you're
// checking for — same script, same browser engine, different real hardware.
// -----------------------------------------------------------------------------

const { chromium } = require("playwright");

const TARGET_URL = process.env.TARGET_URL;
const OUTPUT_PATH = process.env.OUTPUT_PATH ?? "screenshot-output.png";

// A fixed viewport keeps screenshots comparable across OSes — otherwise a
// difference in default window size would look like a rendering bug.
const VIEWPORT = { width: 1440, height: 900 };

/** Guards against running with no target — fails loudly instead of silently. */
const assertTargetUrlProvided = () => {
  if (!TARGET_URL) {
    throw new Error("TARGET_URL environment variable is required.");
  }
};

/** Launches Chromium, navigates to the target, and saves a full-page screenshot. */
const captureScreenshot = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle" });
    await page.screenshot({ path: OUTPUT_PATH, fullPage: true });
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
