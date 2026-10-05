#!/usr/bin/env node
// Real-browser verification of CaterLink-only access on the private staging preview (desktop + mobile), including
// DIRECT URL requests and direct API requests with each identity's own session. Credentials come from the private
// files outside the repository and are typed into the real login form in memory; nothing sensitive is printed.
//
// Usage: node scripts/staging/preview-caterlink-test.mjs --url=https://<preview-alias> --bypass-file=<path>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { defaultCredentialsDir } from "./lib/run-gates.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const bypassFile = argVal("bypass-file");
if (!base?.startsWith("https://") || !bypassFile) throw new Error("--url=https://... and --bypass-file=<path> are required");
const bypass = fs.readFileSync(bypassFile, "utf8").trim();
const BASE_RUN = "dashboard-review-20261005";
const load = (run) => JSON.parse(fs.readFileSync(path.join(defaultCredentialsDir(run), `credentials-${run}.json`), "utf8")).accounts;
const accounts = [...load(BASE_RUN), ...load(`${BASE_RUN}-receipt`), ...load(`${BASE_RUN}-caterlink`)];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evDir = path.join(os.tmpdir(), "vecta-preview-evidence", `caterlink-${stamp}`);
fs.mkdirSync(evDir, { recursive: true });
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const VIEWPORTS = { desktop: { width: 1366, height: 850 }, mobile: { width: 390, height: 844 } };

const CL = {
  caterlink_management: "CaterLink Management",
  "caterlink-driver": "CaterLink Driver",
  "caterlink-vendor": "Third-Party Vendor",
};
const FORBIDDEN_PAGES = ["/", "/avsec/home", "/avsec/dashboard", "/avsec/my-dashboard", "/avsec/admin/users", "/avsec/reports/sec014", "/avsec/duty", "/super-admin"];
const FORBIDDEN_API = ["/api/wois/chat", "/api/avsec/export"];
const VECTA_REPS = [
  ["aso-no-caterlink", "/"], ["operation_manager", "/"], ["main_enforcement", "/"], ["maa_admin", "/avsec/my-dashboard"],
  ["sso", "/"], ["aso-jhb", "/"], ["aso-kul", "/"], ["aso-kch-receipt", "/"], ["super_admin", "/super-admin"],
];

let failures = 0;
const results = [];
const ok = (label, cond, note = "") => { if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

async function ctxFor(browser, vp) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  const page = await ctx.newPage();
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  return { ctx, page };
}
async function login(page, a) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname) || /error=/.test(u.search), { timeout: 25000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}
const pathOf = (page) => new URL(page.url()).pathname;

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    // ---------- the three CaterLink-only identities ----------
    for (const [label, display] of Object.entries(CL)) {
      const a = accounts.find((x) => x.label === label);
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const { ctx, page } = await ctxFor(browser, vp);
        const tag = `${display} (${vpName})`;
        try {
          await login(page, a);
          ok(`${tag}: signs in and lands on /caterlink/dashboard`, /^\/(caterlink|icms)\/dashboard/.test(pathOf(page)), `landed ${pathOf(page)}`);
          const bodyText = (await page.textContent("body")) ?? "";
          ok(`${tag}: CaterLink branding is shown`, /CaterLink/.test(bodyText));
          const hrefs = await page.$$eval("a[href]", (els) => els.map((e) => e.getAttribute("href") ?? ""));
          const internal = [...new Set(hrefs.filter((h) => h.startsWith("/")))];
          const bad = internal.filter((h) => !/^\/(caterlink|icms|login|auth|manifest|favicon|_next)/.test(h) || /^\/avsec|^\/super-admin|^\/$/.test(h));
          ok(`${tag}: navigation offers only CaterLink destinations`, bad.length === 0, bad.slice(0, 5).join(","));
          ok(`${tag}: no app-switch / VECTA dashboard / AVSEC / Super Admin text or control`, !/Operations Dashboard|My Dashboard|Bay Board|Discussion Board|Roster|Attendance|Super Admin|W\.O\.I\.S/i.test(bodyText));
          ok(`${tag}: sign-out control is present`, (await page.getByRole("button", { name: /sign out/i }).count()) > 0);
          ok(`${tag}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)));
          await page.screenshot({ path: path.join(evDir, `${label}-${vpName}.png`) });
          if (vpName === "desktop") {
            // DIRECT URL requests
            for (const p of FORBIDDEN_PAGES) {
              await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
              await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
              const fp = pathOf(page);
              const t = (await page.textContent("body")) ?? "";
              ok(`${tag}: direct ${p} is redirected to CaterLink, no VECTA content`, /^\/(caterlink|icms)\//.test(fp) && !/AVSEC Reports|Operations Dashboard|File Security Report|Super Admin/i.test(t), `ended on ${fp}`);
            }
            // DIRECT API requests with the identity's own session cookies
            for (const p of FORBIDDEN_API) {
              const r = await page.request.get(`${base}${p}`, { failOnStatusCode: false });
              ok(`${tag}: direct API ${p} answers 403`, r.status() === 403, `status ${r.status()}`);
            }
            const h = await page.request.get(`${base}/api/health`, { failOnStatusCode: false });
            ok(`${tag}: the health endpoint stays reachable`, [200, 503].includes(h.status()));
            if (label === "caterlink_management") {
              for (const p of ["/caterlink/transactions", "/icms/incidents", "/icms/admin/whitelists", "/icms/admin/archive", "/icms/reports"]) {
                await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
                await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
                const t = await page.textContent("body");
                ok(`${tag}: approved function page ${p} opens inside CaterLink`, /^\/(caterlink|icms)\//.test(pathOf(page)) && !/forbidden/i.test(page.url()) && (t ?? "").length > 50, pathOf(page));
              }
            } else {
              for (const p of ["/icms/admin/whitelists", "/icms/admin/archive", "/icms/admin/audit", "/icms/reports"]) {
                await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
                await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
                ok(`${tag}: management page ${p} is denied`, /error=forbidden/.test(page.url()) || /^\/(caterlink|icms)\/dashboard/.test(pathOf(page)), `ended on ${pathOf(page)}`);
              }
              const other = label === "caterlink-driver" ? "/icms/vendor-transactions/new" : "/icms/transactions/new";
              await page.goto(`${base}${other}`, { waitUntil: "domcontentloaded" });
              await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
              ok(`${tag}: the other external role's workflow (${other}) is denied`, /error=forbidden/.test(page.url()) || !new RegExp(other.replace(/\//g, "\\/")).test(pathOf(page).replace(/^\/caterlink/, "/icms")), `ended on ${pathOf(page)}`);
            }
          }
        } catch (e) { ok(`${tag}: test run`, false, String(e.message).slice(0, 120)); }
        await ctx.close();
      }
    }

    // ---------- VECTA identities ----------
    for (const [label, expectPath] of VECTA_REPS) {
      const a = accounts.find((x) => x.label === label);
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const { ctx, page } = await ctxFor(browser, vp);
        try {
          await login(page, a);
          ok(`${label} (${vpName}): signs in and lands on ${expectPath}`, pathOf(page) === expectPath, `landed ${pathOf(page)}`);
          const t = (await page.textContent("body")) ?? "";
          if (label !== "super_admin") ok(`${label} (${vpName}): VECTA workspace (not the CaterLink shell)`, !/Catering movement control/.test(t) || label === "aso-no-caterlink" && /VECTA/.test(t));
          await page.screenshot({ path: path.join(evDir, `${label}-${vpName}.png`) });
          if (vpName === "desktop" && label === "aso-no-caterlink") {
            await page.goto(`${base}/avsec/home`, { waitUntil: "domcontentloaded" });
            ok("aso-no-caterlink: can open its VECTA workspace page directly (no CaterLink redirect)", /^\/avsec\//.test(pathOf(page)), pathOf(page));
          }
          if (vpName === "desktop" && ["aso-jhb", "sso"].includes(label)) {
            const links = await page.$$eval("a[href]", (els) => els.map((e) => e.getAttribute("href") ?? ""));
            ok(`${label}: scan control visible (PEN/JHB eligible)`, links.some((h) => /\/scan\b/.test(h)));
          }
          if (vpName === "desktop" && ["aso-kul", "aso-kch-receipt", "operation_manager"].includes(label)) {
            const links = await page.$$eval("a[href]", (els) => els.map((e) => e.getAttribute("href") ?? ""));
            ok(`${label}: no scan control`, !links.some((h) => /\/scan\b/.test(h)));
          }
        } catch (e) { ok(`${label} (${vpName}): test run`, false, String(e.message).slice(0, 120)); }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(evDir, "results.json"), JSON.stringify({ base, at: new Date().toISOString() }, null, 2));
  console.log(`\nEvidence directory: ${evDir}\nTotal failures: ${failures}`);
  void results;
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
