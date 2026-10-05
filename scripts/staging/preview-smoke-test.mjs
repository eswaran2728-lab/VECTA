#!/usr/bin/env node
// Browser smoke test of the private staging preview (desktop + mobile). Credentials are read from the private
// credential files OUTSIDE the repository and typed into the real login form in memory; they are never printed.
// Protection bypass uses the project's automation secret (private file) via the bypass cookie.
// Evidence (screenshots without credentials) goes to %TEMP%\vecta-preview-evidence\<stamp>.
//
// Usage: node scripts/staging/preview-smoke-test.mjs --url=https://<preview-alias> [--only=label1,label2]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { defaultCredentialsDir } from "./lib/run-gates.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const only = argVal("only")?.split(",");
const STAGING_REF = "ddlctzbnqewubltcavkh";
const PROD_REF = "zsxneokqulktgnccxgkz";
if (!base?.startsWith("https://")) throw new Error("--url=https://... is required");

const baseRun = "dashboard-review-20261005";
const credDir = defaultCredentialsDir(baseRun);
const bypass = fs.readFileSync(path.join(credDir, "vercel-bypass.txt"), "utf8").trim();
const loadCreds = (run) => JSON.parse(fs.readFileSync(path.join(defaultCredentialsDir(run), `credentials-${run}.json`), "utf8")).accounts;
const accounts = [...loadCreds(baseRun), ...loadCreds(`${baseRun}-receipt`)];
const REPS = [
  "super_admin", "airasia_management", "maa_boss", "maa_admin", "aax_admin", "operation_manager", "main_enforcement",
  "caterlink_management", "hub_se", "dse", "sso", "aso-jhb", "aso-kul", "aso-no-caterlink", "aso-kch-receipt", "aso-bki-receipt",
  "neg-pending-profile", "neg-revoked-assignment",
];
const targets = (only ?? REPS).map((l) => accounts.find((a) => a.label === l)).filter(Boolean);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evDir = path.join(os.tmpdir(), "vecta-preview-evidence", stamp);
fs.mkdirSync(evDir, { recursive: true });
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const VIEWPORTS = { desktop: { width: 1366, height: 850 }, mobile: { width: 390, height: 844 } };

const hosts = new Set();
const results = [];
let failures = 0;
const ok = (label, cond, note = "") => { if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

async function newContext(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  ctx.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 120)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 120)}`); });
  page.on("response", (r) => { if (r.status() >= 400) { try { const u = new URL(r.url()); errors.push(`http ${r.status()}: ${u.hostname.startsWith("ddlct") ? "supabase" : "preview"}${u.pathname.slice(0, 80)}`); } catch { /* ignore */ } } });
  // set the protection-bypass cookie once
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  return { ctx, page, errors };
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // ---- unauthenticated behaviour & invalid credentials ----
    {
      const { ctx, page } = await newContext(browser, VIEWPORTS.desktop);
      await page.goto(`${base}/avsec/home`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
      ok("Unauthenticated visitor to /avsec/home is redirected to the app sign-in page", /\/login/.test(page.url()));
      await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', "nobody@example.invalid");
      await page.fill('input[name="password"]', "definitely-wrong-password");
      await page.getByRole('button', { name: /Sign in with Credentials/i }).click();
      await page.waitForTimeout(3500);
      const text = (await page.textContent("body")) ?? "";
      ok("Invalid credentials are rejected and the user stays on /login", /\/login/.test(page.url()) && /invalid|incorrect|failed|wrong/i.test(text));
      await page.screenshot({ path: path.join(evDir, "invalid-credentials-desktop.png") });
      await ctx.close();
    }

    // ---- representative roles, desktop + mobile ----
    for (const a of targets) {
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const rec = { label: a.label, viewport: vpName, errors: [] };
        const { ctx, page, errors } = await newContext(browser, vp);
        try {
          await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
          await page.fill('input[name="email"]', a.email);
          await page.fill('input[name="password"]', a.password);
          await page.getByRole('button', { name: /Sign in with Credentials/i }).click();
          await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          rec.path = new URL(page.url()).pathname;
          const links = await page.$$eval("a[href]", (els) => els.map((e) => ({ h: e.getAttribute("href") ?? "", t: (e.textContent ?? "").trim().slice(0, 40) })));
          rec.nav = [...new Set(links.map((l) => l.h).filter((h) => h.startsWith("/")))].slice(0, 40);
          const bodyText = (await page.textContent("body")) ?? "";
          rec.scanControls = links.some((l) => /\/scan\b/.test(l.h)) || /\bscan\b/i.test(links.map((l) => l.t).join(" "));
          rec.receiptText = /receipt/i.test(bodyText);
          rec.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
          await page.screenshot({ path: path.join(evDir, `${a.label}-${vpName}.png`), fullPage: false });
          // sign out by discarding the whole browser context (no session survives)
        } catch (e) { rec.error = String(e.message).slice(0, 120); }
        rec.errors = errors.slice(0, 5);
        await ctx.close();
        results.push(rec);
      }
    }
  } finally { await browser.close(); }

  // ---- evaluate ----
  const by = (l, vp = "desktop") => results.find((r) => r.label === l && r.viewport === vp);
  console.log("\n--- landing / navigation (desktop) ---");
  for (const r of results.filter((x) => x.viewport === "desktop")) console.log(`${r.label.padEnd(26)} ${String(r.path ?? r.error).padEnd(28)} navLinks=${r.nav?.length ?? 0} scanControls=${r.scanControls} overflow(d/m)=${r.horizontalOverflow}/${by(r.label, "mobile")?.horizontalOverflow}`);
  // Observed design: global/entity roles land on /avsec/my-dashboard; operational roles land on the root landing page "/";
  // caterlink_management lands on /caterlink/dashboard; blocked accounts on /avsec/pending-approval.
  const expectLanding = { super_admin: "/super-admin", airasia_management: "/avsec/my-dashboard", maa_boss: "/avsec/my-dashboard", maa_admin: "/avsec/my-dashboard", aax_admin: "/avsec/my-dashboard", operation_manager: "/", main_enforcement: "/", caterlink_management: "/caterlink/dashboard", hub_se: "/", dse: "/", sso: "/", "aso-jhb": "/", "aso-kul": "/", "aso-no-caterlink": "/", "aso-kch-receipt": "/", "aso-bki-receipt": "/", "neg-pending-profile": "/avsec/pending-approval", "neg-revoked-assignment": "/avsec/pending-approval" };
  for (const l of targets.map((t) => t.label)) for (const vp of ["desktop", "mobile"]) {
    const r = by(l, vp);
    ok(`${l} (${vp}) signs in and lands on ${expectLanding[l]}`, r && !r.error && r.path === expectLanding[l], r?.error ?? `landed ${r?.path}`);
  }
  console.log("\n--- scan controls ---");
  const scanExpect = { sso: true, "aso-jhb": true, dse: false, "aso-kul": false, "aso-no-caterlink": false, "aso-kch-receipt": false, "aso-bki-receipt": false, operation_manager: false, main_enforcement: false, hub_se: false, caterlink_management: false, maa_admin: false, "neg-pending-profile": false };
  for (const [l, want] of Object.entries(scanExpect)) { const r = by(l); if (r) ok(`${l}: scan controls ${want ? "visible" : "absent"}`, r.scanControls === want, `observed ${r.scanControls}`); }
  const unsafeHosts = [...hosts].filter((h) => h.includes(PROD_REF));
  ok("No network request went to the production Supabase project", unsafeHosts.length === 0);
  ok("Browser traffic reached only the preview host and the staging Supabase project (plus static/font hosts)", [...hosts].every((h) => h.endsWith("vercel.app") || h.startsWith(STAGING_REF) || /gstatic|googleapis|vercel/.test(h)), [...hosts].join(","));
  const errs = results.flatMap((r) => r.errors.map((e) => `${r.label}/${r.viewport}: ${e}`));
  console.log(`\nBrowser console/page errors: ${errs.length}`); errs.slice(0, 12).forEach((e) => console.log("  " + e));
  fs.writeFileSync(path.join(evDir, "results.json"), JSON.stringify({ base, results: results.map(({ errors, ...r }) => ({ ...r, errorCount: errors.length })) }, null, 2));
  console.log(`\nEvidence directory: ${evDir}\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
