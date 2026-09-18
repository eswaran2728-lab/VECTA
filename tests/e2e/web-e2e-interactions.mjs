import { chromium } from "playwright";
import assert from "node:assert/strict";
import path from "node:path";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\eswaranp\\.gemini\\antigravity-ide\\brain\\edc5c060-d805-4547-9a22-bae5f9471831";
const BASE_URL = "http://localhost:3000";

async function runInteractions() {
  console.log("=== STARTING PHASE 4: UI & RELIABILITY HARDENING REAL BROWSER TESTS ===");

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  try {
    // 1. Test CaterLink tab switch on register page
    await page.goto(`${BASE_URL}/register`, { waitUntil: "networkidle" });
    const caterlinkTab = page.locator('button:has-text("CATERLINK")');
    await caterlinkTab.click();
    await page.waitForTimeout(500);

    // Verify CaterLink specific fields appear (e.g. Vendor Company, IC Number / Passport, Vehicle No)
    const content = await page.content();
    assert.ok(
      content.includes("Catering") || content.includes("Vendor") || content.includes("Vehicle") || content.includes("Driver"),
      "CaterLink tab switch must render driver/vendor specific registration fields"
    );

    const caterlinkScreenshot = path.join(ARTIFACT_DIR, "e2e_register_caterlink_tab.png");
    await page.screenshot({ path: caterlinkScreenshot });
    console.log("[PASS] CaterLink Registration Tab Switch Verified & Captured");

    // 2. Test empty submission triggers native or React Hook Form validation without crash
    const submitBtn = page.locator('button:has-text("Submit Registration")');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Form must not submit to a non-existent page or crash
    assert.ok(page.url().includes("/register"), "Page must stay on /register when invalid");
    console.log("[PASS] Form Validation Prevents Premature Submissions");

    // 3. Test responsive layout at 375px (iPhone SE width)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });

    // Check for horizontal overflow (scrollWidth <= clientWidth + 1)
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    assert.equal(hasHorizontalScroll, false, "Mobile viewport must not produce horizontal overflow");
    console.log("[PASS] Mobile Viewport Responsiveness: Zero Horizontal Scroll Overflow");

    // 4. Test Unauthenticated Route Probe Protection (No URL enumeration)
    const resProbe = await page.goto(`${BASE_URL}/non-existent-route-qa-test-404`, { waitUntil: "networkidle" });
    assert.ok(page.url().includes("/login?next=%2Fnon-existent-route-qa-test-404"), "Unauthenticated unknown route must redirect to login");
    console.log("[PASS] Unauthenticated Route Probe Protection (Prevents Endpoint Enumeration)");

  } finally {
    await browser.close();
  }
}

runInteractions().catch((err) => {
  console.error("Phase 4 tests failed:", err);
  process.exit(1);
});
