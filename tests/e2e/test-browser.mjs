import { chromium } from "playwright";

async function main() {
  console.log("Testing launch of local Google Chrome...");
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });

  const page = await browser.newPage();
  await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
  const title = await page.title();
  console.log("Page title:", title);
  console.log("Current URL:", page.url());

  const screenshotPath = "C:\\Users\\eswaranp\\.gemini\\antigravity-ide\\brain\\edc5c060-d805-4547-9a22-bae5f9471831\\login_screen_real_chrome.png";
  await page.screenshot({ path: screenshotPath });
  console.log("Screenshot saved to:", screenshotPath);

  await browser.close();
  console.log("Browser closed successfully!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
