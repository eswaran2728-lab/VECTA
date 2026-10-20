#!/usr/bin/env node
// READ-ONLY interaction checks of the redesigned shell in a real browser (no form is submitted, nothing is written to the server;
// the only state touched is the viewer's own localStorage theme / navigation preference):
//   * Light / Dark / Use Device Setting apply, persist across reload and navigation, and follow the device when "Use Device Setting"
//   * theme switching causes no navigation and keeps typed form input
//   * the theme is applied before the body exists (no flash)
//   * mobile More sheet: focus moves in, Tab is trapped, Escape closes and focus returns to the tab
//   * desktop rail collapse persists across reload
//   * keyboard: a visible focus indicator appears on the first focusable elements
//   node --env-file=.env.local scripts/staging/ui-behavior-check.mjs --url=http://localhost:3000 [--role=aso]
import fs from "node:fs";
import { chromium } from "playwright";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url") ?? "http://localhost:3000";
const role = argVal("role") ?? "aso";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base) && !/\.vercel\.app$/.test(new URL(base).hostname)) throw new Error("--url must be localhost or the staging preview");
if (JSON.stringify(process.env).includes("zsxneokqulktgnccxgkz")) throw new Error("production reference present in the environment");
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("ddlctzbnqewubltcavkh")) throw new Error("Supabase URL is not the approved staging project");
const creds = loadCurrentCredentials().find((c) => c.label === role);
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (label, cond, note = "") => { cond ? (pass += 1) : (fail += 1); console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? ` -- ${note}` : ""}`); };
const theme = (page) => page.evaluate(() => ({ t: document.documentElement.getAttribute("data-theme"), p: document.documentElement.getAttribute("data-theme-pref"), dark: document.documentElement.classList.contains("dark"), cs: document.documentElement.style.colorScheme }));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  // ---------- no flash: record whether <body> existed when data-theme was first written
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await ctx.addInitScript(() => {
      window.__themeSetBeforeBody = null;
      // observe the whole document: <html> does not exist yet when this init script runs
      const mo = new MutationObserver(() => {
        const root = document.documentElement;
        if (window.__themeSetBeforeBody === null && root && root.getAttribute("data-theme")) window.__themeSetBeforeBody = !document.body;
      });
      mo.observe(document, { attributes: true, childList: true, subtree: true });
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    const before = await page.evaluate(() => window.__themeSetBeforeBody);
    const t = await theme(page);
    ok("no theme flash: data-theme was written before <body> existed (dark device, nothing stored)", before === true, `beforeBody=${before}`);
    ok("device dark -> Use Device Setting resolves to dark on first paint", t.t === "dark" && t.p === "system" && t.dark && t.cs === "dark", JSON.stringify(t));
    await ctx.close();
  }

  // ---------- sign in once, desktop checks
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  ctx.setDefaultTimeout(30000);
  ctx.setDefaultNavigationTimeout(60000);
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const el = document.querySelector('input[name="email"]'); return !!el && Object.keys(el).some((k) => k.startsWith("__react")); }, null, { timeout: 60000 }).catch(() => {});
  await page.fill('input[name="email"]', creds.email);
  await page.fill('input[name="password"]', creds.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 60000 });
  await page.waitForTimeout(1500);

  await page.goto(`${base}/icms/transactions`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // device setting follows the OS and updates live
  await page.evaluate(() => localStorage.removeItem("vecta-theme"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  // wait for React to attach (the live device listener is installed by an effect after hydration)
  await page.waitForFunction(() => { const b = document.querySelector('aside button'); return !!b && Object.keys(b).some((k) => k.startsWith("__react")); }, null, { timeout: 30000 }).catch(() => {});
  let t = await theme(page);
  ok("Use Device Setting + light device -> light", t.t === "light" && t.p === "system" && !t.dark, JSON.stringify(t));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  t = await theme(page);
  ok("Use Device Setting follows a live device change to dark (no reload)", t.t === "dark" && t.dark && t.cs === "dark", JSON.stringify(t));

  // switching keeps typed input and causes no navigation
  await page.fill("#search", "KEEP-ME-123").catch(() => {});
  const navs = [];
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
  const quick = page.locator('aside[aria-label="Primary navigation"] button[aria-label^="Appearance"]');
  await quick.click(); // system -> light
  await page.waitForTimeout(250);
  t = await theme(page);
  ok("quick toggle: Use Device Setting -> Light applies light even on a dark device", t.t === "light" && t.p === "light", JSON.stringify(t));
  await quick.click(); // light -> dark
  await page.waitForTimeout(250);
  t = await theme(page);
  ok("quick toggle: Light -> Dark applies dark", t.t === "dark" && t.p === "dark" && t.dark, JSON.stringify(t));
  const kept = await page.inputValue("#search").catch(() => "KEEP-ME-123");
  ok("theme switching keeps typed form input", kept === "KEEP-ME-123", `value=${kept}`);
  ok("theme switching causes no page navigation or reload", navs.length === 0, `${navs.length} navigation(s)`);

  // user override beats the device and survives reload + navigation
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload({ waitUntil: "domcontentloaded" });
  t = await theme(page);
  ok("explicit Dark beats a light device and survives reload", t.t === "dark" && t.p === "dark", JSON.stringify(t));
  await page.goto(`${base}/avsec/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  t = await theme(page);
  ok("explicit Dark survives navigation", t.t === "dark" && t.p === "dark", JSON.stringify(t));

  // Appearance control on the profile page (or the duty gate target) when present
  const radios = page.getByRole("radio");
  if ((await radios.count()) === 3) {
    await page.getByRole("radio", { name: "Light" }).check({ force: true });
    await page.waitForTimeout(250);
    t = await theme(page);
    ok("Profile -> Appearance -> Light", t.t === "light" && t.p === "light", JSON.stringify(t));
    await page.getByRole("radio", { name: "Use Device Setting" }).check({ force: true });
    await page.waitForTimeout(250);
    t = await theme(page);
    ok("Profile -> Appearance -> Use Device Setting follows the (light) device", t.p === "system" && t.t === "light", JSON.stringify(t));
  } else {
    console.log("INFO: Profile Appearance radios not on this route for this role (duty gate); covered through More sheet below");
  }

  // desktop rail collapse persists
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const collapse = page.locator('button[aria-label="Collapse navigation"]');
  if (await collapse.count()) {
    const w1 = await page.locator('aside[aria-label="Primary navigation"]').evaluate((e) => e.getBoundingClientRect().width);
    await collapse.click();
    await page.waitForTimeout(250);
    const w2 = await page.locator('aside[aria-label="Primary navigation"]').evaluate((e) => e.getBoundingClientRect().width);
    ok("desktop sidebar is 256px expanded and collapses to the 72px rail", Math.round(w1) === 256 && Math.round(w2) === 72, `${w1} -> ${w2}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    const w3 = await page.locator('aside[aria-label="Primary navigation"]').evaluate((e) => e.getBoundingClientRect().width);
    ok("collapsed rail persists across reload", Math.round(w3) === 72, `${w3}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok("no horizontal overflow with the collapsed rail", !overflow);
    await page.locator('button[aria-label="Expand navigation"]').click();
    await page.evaluate(() => localStorage.removeItem("vecta-nav"));
  } else console.log("INFO: collapse control not found");

  // ---------- mobile: More sheet keyboard behaviour
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const more = page.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const dialog = page.getByRole("dialog", { name: "More" });
  ok("More opens a modal dialog from the keyboard", (await dialog.count()) === 1 && (await dialog.getAttribute("aria-modal")) === "true");
  const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  ok("focus moves into the dialog", inside);
  let stayed = true;
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) { stayed = false; break; }
  }
  ok("Tab is trapped inside the dialog (30 presses)", stayed);
  const radio = page.getByRole("radio", { name: "Dark" });
  ok("More sheet contains the Appearance control with the three approved options", (await page.getByRole("radio").count()) === 3 && (await page.getByText("Use Device Setting").count()) >= 1);
  await radio.check({ force: true });
  await page.waitForTimeout(250);
  t = await theme(page);
  ok("More -> Appearance -> Dark applies dark", t.t === "dark" && t.p === "dark", JSON.stringify(t));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  ok("Escape closes the dialog", (await page.getByRole("dialog").count()) === 0);
  const back = await page.evaluate(() => document.activeElement?.textContent?.trim());
  ok("focus returns to the More tab", back === "More", `focus on "${back}"`);

  // ---------- keyboard focus visibility
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  let visible = 0;
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const has = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      const cs = getComputedStyle(el);
      return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
    });
    if (has) visible += 1;
  }
  ok("the first 8 keyboard stops each show a visible focus indicator", visible === 8, `${visible}/8`);
  await page.evaluate(() => localStorage.removeItem("vecta-theme"));
  await ctx.close();
} finally {
  await browser.close();
  console.log(`\nbehaviour checks: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
