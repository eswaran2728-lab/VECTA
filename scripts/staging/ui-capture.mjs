#!/usr/bin/env node
// READ-ONLY visual and layout capture of the redesigned shell. Navigation and GET requests only: no form is submitted, nothing is
// written, no fixture is created. Credentials come from the private files outside the repository (same loader as the other staging
// scripts) and are typed into the real login form in memory; nothing sensitive is printed.
//
//   node --env-file=.env.local scripts/staging/ui-capture.mjs --url=http://localhost:3000 [--roles=aso,operation_manager]
//        [--viewports=mobile,tablet,laptop,desktop] [--themes=light,dark] [--only=/,/avsec/profile]
//
// For every role x route x viewport x theme it saves a PNG and records: final path (a redirect is the real state, e.g. the duty
// check-in gate), horizontal overflow, h1 count, tap targets under 44px in the primary navigation, and console errors.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url") ?? "http://localhost:3000";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base) && !/\.vercel\.app$/.test(new URL(base).hostname)) throw new Error("--url must be localhost or the staging preview");
if (JSON.stringify(process.env).includes("zsxneokqulktgnccxgkz")) throw new Error("production reference present in the environment");
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("ddlctzbnqewubltcavkh")) throw new Error("Supabase URL is not the approved staging project");

const VIEWPORTS = { mobile: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, laptop: { width: 1280, height: 800 }, desktop: { width: 1440, height: 900 } };
const ROUTES = {
  aso: ["/", "/avsec/duty", "/avsec/profile", "/avsec/bay-board", "/icms/transactions"],
  operation_manager: ["/avsec/my-dashboard", "/avsec/profile", "/avsec/bay-board", "/avsec/reports/lookup", "/avsec/discussions"],
};
const roles = (argVal("roles") ?? "aso,operation_manager").split(",");
const vps = (argVal("viewports") ?? "mobile,tablet,laptop,desktop").split(",");
const themes = (argVal("themes") ?? "light,dark").split(",");
const only = argVal("only")?.split(",");
const creds = loadCurrentCredentials();
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evDir = path.join(os.tmpdir(), "vecta-ui-evidence", `capture-${stamp}`);
fs.mkdirSync(evDir, { recursive: true });
const results = [];

async function login(page, label) {
  const a = creds.find((c) => c.label === label);
  if (!a) throw new Error(`no credentials for ${label}`);
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const el = document.querySelector('input[name="email"]'); return !!el && Object.keys(el).some((k) => k.startsWith("__react")); }, null, { timeout: 60000 }).catch(() => {});
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 60000 });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const label of roles) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS.mobile });
    ctx.setDefaultTimeout(30000);
    ctx.setDefaultNavigationTimeout(60000);
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 160)}`));
    await login(page, label);
    for (const route of (ROUTES[label] ?? []).filter((r) => !only || only.includes(r))) {
      for (const theme of themes) {
        // the theme is the user's own local preference; set it exactly as the Appearance control does
        await page.evaluate((t) => localStorage.setItem("vecta-theme", t), theme);
        for (const vp of vps) {
          await page.setViewportSize(VIEWPORTS[vp]);
          errors.length = 0;
          await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(600);
          const m = await page.evaluate(() => {
            const de = document.documentElement;
            const nav = [...document.querySelectorAll('nav[aria-label="Primary"] a, nav[aria-label="Primary"] button, aside[aria-label="Primary navigation"] a, aside[aria-label="Primary navigation"] button')].filter((e) => e.getBoundingClientRect().width > 0);
            return {
              path: location.pathname + location.search,
              theme: de.getAttribute("data-theme"),
              pref: de.getAttribute("data-theme-pref"),
              overflowX: de.scrollWidth > window.innerWidth + 1,
              h1: document.querySelectorAll("h1").length,
              smallNavTargets: nav.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44; }).length,
              smallNavNames: nav.filter((e) => e.getBoundingClientRect().height < 44).map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30)),
              bottomNavVisible: !!document.querySelector('nav[aria-label="Primary"]') && getComputedStyle(document.querySelector('nav[aria-label="Primary"]')).display !== "none",
              railVisible: !!document.querySelector('aside[aria-label="Primary navigation"]') && getComputedStyle(document.querySelector('aside[aria-label="Primary navigation"]')).display !== "none",
            };
          });
          const file = `${label}__${route.replace(/[^a-z0-9]+/gi, "_") || "home"}__${vp}__${theme}.png`;
          await page.screenshot({ path: path.join(evDir, file), fullPage: false });
          results.push({ role: label, route, viewport: vp, requestedTheme: theme, ...m, consoleErrors: [...errors], file });
          console.log(`${m.overflowX ? "OVERFLOW" : "ok      "} ${label} ${route} -> ${m.path} ${vp}/${theme} h1=${m.h1} smallTargets=${m.smallNavTargets}${m.smallNavNames.length ? `(${m.smallNavNames.join("|")})` : ""} bottomNav=${m.bottomNavVisible} rail=${m.railVisible} errors=${errors.length}`);
        }
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(path.join(evDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`evidence: ${evDir}`);
}
