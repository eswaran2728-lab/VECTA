#!/usr/bin/env node
// Hosted verification of the station weather card (hourly strip from WeatherAPI.com + daily MET Malaysia) on a private staging Preview, with real signed-in
// sessions of station-scoped and station-less roles, on mobile and desktop, in light and dark themes. Read-only: no database writes, no fixtures. The Preview
// calls both providers server-side; this script never sees the WeatherAPI key.
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
const shots = path.join(process.env.TEMP ?? ".", "vecta-weather-shots");
fs.mkdirSync(shots, { recursive: true });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

const cases = [
  { label: "sso-kul", station: "KUL - MAA" },
  { label: "profiling_so", station: "PEN" },
  { label: "sso-jhb", station: "JHB" },
  { label: "ghod", station: null },
];
const consoleErrors = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const login = async (page, label) => {
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', cred(label).email);
  await page.fill('input[name="password"]', cred(label).password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
};
const settle = async (page, p) => {
  await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
};
const parseRgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

try {
  for (const c of cases) {
    for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
      for (const scheme of ["light", "dark"]) {
        if (scheme === "dark" && c.label !== "sso-kul") continue; // both themes are checked on the primary account; the others in light
        const tag = `${c.label} ${name} ${scheme}`;
        const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500, colorScheme: scheme });
        const page = await ctx.newPage();
        page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js|Failed to load resource/.test(m.text())) consoleErrors.push(`${tag}: ${m.text().slice(0, 100)}`); });
        await login(page, c.label);
        await settle(page, "/avsec/my-dashboard");
        const card = page.getByTestId("station-weather");
        const shown = await card.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
        ok(`${tag}: the weather card renders`, shown);
        if (!shown) { await ctx.close(); continue; }
        const text = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
        const box = await card.boundingBox();

        ok(`${tag}: no loading skeleton is left behind`, (await page.getByTestId("station-weather-loading").count()) === 0);
        ok(`${tag}: both sources are labelled separately, with the forecast and aviation disclaimer`, /Hourly · WeatherAPI\.com|Hourly forecast/.test(text) && /Daily · MET Malaysia|Daily forecast/.test(text) && /MET Malaysia via data\.gov\.my \(CC BY 4\.0\)/.test(text) && /not live observations and not aviation weather clearance/.test(text));
        ok(`${tag}: no horizontal page scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);

        if (c.station) {
          const strip = page.getByTestId("hourly-strip");
          const hasStrip = await strip.count();
          ok(`${tag}: the hourly strip shows real WeatherAPI hours (time, condition, temperature, rain chance)`, hasStrip === 1 && (await strip.locator("li").count()) >= 12, hasStrip ? "" : "hourly unavailable: " + ((await page.getByTestId("hourly-unavailable").textContent().catch(() => "")) ?? ""));
          if (hasStrip) {
            const first = (await strip.locator("li").first().getAttribute("aria-label")) ?? "";
            ok(`${tag}: the first tile is the current hour with a degree and a rain-chance reading`, /^Now, \d{1,2} (AM|PM): .+, -?\d+ degrees Celsius, (\d+ percent chance of rain|rain chance not given)$/.test(first), first);
            const geo = await strip.evaluate((el) => {
              const s = el.getBoundingClientRect();
              const tiles = [...el.querySelectorAll("li")].map((li) => li.getBoundingClientRect());
              return { sw: el.scrollWidth, cw: el.clientWidth, full: tiles.filter((r) => r.left >= s.left - 2 && r.right <= s.right + 2).length, partial: tiles.filter((r) => r.right > s.left && r.left < s.right).length };
            });
            if (name === "mobile") ok(`${tag}: two to three hours are fully visible, the rest scroll sideways`, geo.full >= 2 && geo.full <= 3 && geo.sw > geo.cw + 100, JSON.stringify(geo));
            else ok(`${tag}: the strip scrolls sideways on desktop too`, geo.sw > geo.cw, JSON.stringify(geo));
            const before = await strip.evaluate((el) => el.scrollLeft);
            await strip.evaluate((el) => el.scrollBy({ left: el.clientWidth, behavior: "instant" }));
            const after = await strip.evaluate((el) => el.scrollLeft);
            ok(`${tag}: scrolling reveals later hours`, after > before);
            await strip.focus();
            await strip.evaluate((el) => { el.scrollLeft = 0; });
            await page.keyboard.press("ArrowRight");
            ok(`${tag}: the strip is keyboard focusable and scrolls with the arrow key`, (await strip.getAttribute("tabindex")) === "0" && (await strip.getAttribute("aria-label")).length > 10 && (await strip.evaluate((el) => el.scrollLeft)) > 0);
            const timeEl = strip.locator("li span").first();
            const fg = parseRgb(await timeEl.evaluate((e) => getComputedStyle(e).color));
            const bg = parseRgb(await card.evaluate((e) => { let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; n = n.parentElement; } return "rgb(255,255,255)"; }));
            ok(`${tag}: text contrast is at least 4.5:1`, contrast(fg, bg) >= 4.5, contrast(fg, bg).toFixed(2));
          }
          ok(`${tag}: today's MET Malaysia daily outlook is shown`, (await page.getByTestId("met-today").count()) === 1 && /Morning/.test(text) && /Afternoon/.test(text) && /Night/.test(text));
          const details = page.getByText("More detail", { exact: true });
          await details.click();
          const open = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
          ok(`${tag}: More detail opens the next hours and the next days with their sources`, /Next hours · WeatherAPI\.com/.test(open) && /Next days · MET Malaysia/.test(open));
          if (name === "mobile") ok(`${tag}: collapsed card stays compact`, box.height <= 330, `${Math.round(box.height)}px`);
        } else {
          ok(`${tag}: a role with no station sees safe notes for both sources`, /station assignment/.test(text) && !/error|exception/i.test(text), text.slice(0, 90));
        }
        if (name === "mobile" && c.label === "sso-kul") await page.screenshot({ path: path.join(shots, `my-dashboard-${scheme}.png`) });
        await ctx.close();
      }
    }
  }

  // Duty Check-In stays findable, and the floating AI button never covers a duty warning or action
  for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
    const tag = `sso-kul ${name}`;
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const page = await ctx.newPage();
    await login(page, "sso-kul");
    await settle(page, "/avsec/duty");
    const fab = page.getByRole("button", { name: /Open W\.O\.I\.S AI Assistant/i });
    const fabThere = await fab.count();
    const primary = page.locator(".vecta-btn-primary, .btn-primary").first();
    const pb = await primary.boundingBox().catch(() => null);
    ok(`${tag}: the Duty Check-In action is reachable on the first screen`, Boolean(pb) && pb.y < vp.height, pb ? `${Math.round(pb.y)} of ${vp.height}px` : "no primary action found");
    const clear = async (label) => {
      await page.waitForTimeout(400);
      if (!fabThere) return ok(`${tag}: ${label}: assistant button not present`, true);
      const fb = await fab.boundingBox();
      const hidden = (await fab.getAttribute("data-slot")) === "hidden";
      const targets = await page.locator('.vecta-btn-primary, .btn-primary, [role="alert"], .border-l-warning').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }).filter((r) => r.w > 0 && r.h > 0));
      const hit = fb && !hidden && targets.some((r) => fb.x < r.x + r.w && fb.x + fb.width > r.x && fb.y < r.y + r.h && fb.y + fb.height > r.y);
      ok(`${tag}: ${label}: the assistant button does not cover a warning or action`, !hit);
    };
    await clear("at the top");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await clear("mid-page");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await clear("at the bottom");
    if (name === "mobile") {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(shots, "duty-mobile.png") });
    }
    await ctx.close();
  }
  ok("no browser console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  console.log(`RESULT: ${passes} passed, ${failures} failed. Screenshots: ${shots}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
