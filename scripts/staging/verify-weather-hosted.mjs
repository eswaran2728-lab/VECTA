#!/usr/bin/env node
// Hosted verification of the station weather card on a private staging Preview, with real signed-in sessions of station-scoped and station-less roles, on
// mobile and desktop. Read-only: no database writes, no fixtures. The Preview itself calls the official api.data.gov.my forecast (server-side, cached).
//
// Usage: node --env-file=<staging env> scripts/staging/verify-weather-hosted.mjs --url=https://<preview>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

const base = process.argv.find((a) => a.startsWith("--url="))?.slice(6);
if (!base?.startsWith("https://")) throw new Error("--url=https://<staging preview> is required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || base.includes(FORBIDDEN_REF)) throw new Error("production reference refused");
const accounts = loadCurrentCredentials();
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cases = [
  { label: "sso-kul", station: "KUL - MAA", expect: "Sepang" },
  { label: "profiling_so", station: "PEN", expect: "Barat Daya" },
  { label: "sso-jhb", station: "JHB", expect: "Kulai" },
  { label: "ghod", station: null },
];
const consoleErrors = [];
try {
  for (const c of cases) {
    for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
      const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
      const page = await ctx.newPage();
      page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js|Failed to load resource/.test(m.text())) consoleErrors.push(`${c.label}: ${m.text().slice(0, 100)}`); });
      await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
      await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', cred(c.label).email);
      await page.fill('input[name="password"]', cred(c.label).password);
      await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
      await page.goto(`${base}/avsec/my-dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      const card = page.getByTestId("station-weather");
      const shown = await card.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      const text = shown ? ((await card.textContent()) ?? "").replace(/\s+/g, " ") : "";
      ok(`${c.label} ${name}: the weather card renders on the landing workspace`, shown, shown ? "" : `page ${new URL(page.url()).pathname}`);
      if (shown) {
        if (c.station) {
          ok(`${c.label} ${name}: shows the district, morning/afternoon/night and three following days`, text.includes(c.expect) && /Morning/.test(text) && /Afternoon/.test(text) && /Night/.test(text) && (await card.locator("li").count()) === 3, text.slice(0, 120));
        } else {
          ok(`${c.label} ${name}: a role with no station sees a safe note, not an error`, /station assignment/.test(text) && !/error|exception/i.test(text), text.slice(0, 120));
        }
        ok(`${c.label} ${name}: attribution present and no live/aviation claim`, /MET Malaysia/.test(text) && /data\.gov\.my/.test(text) && /CC BY 4\.0/.test(text) && /Not live observations/.test(text) && /not aviation weather clearance/.test(text));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        ok(`${c.label} ${name}: no horizontal page scroll`, overflow <= 1, `${overflow}px`);
        if (name === "mobile" && c.label === "sso-kul") await page.screenshot({ path: path.join(process.env.TEMP ?? ".", "vecta-weather-mobile.png"), fullPage: false });
      }
      await ctx.close();
    }
  }
  ok("no browser console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  console.log(`RESULT: ${passes} passed, ${failures} failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
