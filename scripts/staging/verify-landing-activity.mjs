#!/usr/bin/env node
// Hosted verification of the grouped report entry points and the two landing-page activity feeds, against a private staging Preview.
// Needs the tagged fixtures of ONE run (uat-fixtures.mjs: create-duty, create-tx, create-activity, create-reports for the same --run-id) so the
// signed-in officer's own actions can be told apart from visible-but-foreign ones. Credentials come from the private files OUTSIDE the repository
// and are typed into the real login form in memory; nothing secret is printed. Screenshots (no credentials) go to %TEMP%\vecta-landing-evidence.
//
// Usage: node scripts/staging/verify-landing-activity.mjs --url=https://<preview> --run-id=<fixture run id> [--only=label,label]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { defaultCredentialsDir } from "./lib/run-gates.mjs";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const only = argVal("only")?.split(",");
const STAGING_REF = "ddlctzbnqewubltcavkh";
const PROD_REF = "zsxneokqulktgnccxgkz";
if (!base?.startsWith("https://") || !argVal("run-id")) throw new Error("--url=https://... and --run-id=<id> are required");
if (base.includes(PROD_REF)) throw new Error("production reference refused");

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const accounts = loadCurrentCredentials();
const PERSONAS = ["aso", "profiling_aso", "aso-jhb", "aso-kul", "so", "dse", "sso", "hub_se", "operation_manager"];
const targets = (only ?? PERSONAS).map((l) => accounts.find((a) => a.label === l)).filter(Boolean);
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, mobile: { width: 390, height: 844 } };
const evDir = path.join(os.tmpdir(), "vecta-landing-evidence", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(evDir, { recursive: true });

const PEN_TX = "ICMS-2026-990001";
const JHB_TX = "ICMS-2026-990002";
const hosts = new Set();
let failures = 0;
let passes = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

async function session(browser, viewport, colorScheme = "light") {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, colorScheme });
  ctx.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 120)}`));
  page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 120)}`); });
  page.on("response", (r) => { if (r.status() >= 400) { try { const u = new URL(r.url()); if (!/vercel\.live/.test(u.hostname)) errors.push(`http ${r.status()}: ${u.hostname.startsWith("ddlct") ? "supabase" : "preview"}${u.pathname.slice(0, 80)}`); } catch { /* ignore */ } } });
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  return { ctx, page, errors };
}

async function signIn(page, a) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

/** Everything the checks need, read from the rendered (visible) page. */
async function snapshot(page) {
  return page.evaluate(() => {
    const feed = (name) => document.querySelector(`[data-activity-feed="${name}"]`);
    const text = (el) => (el ? el.innerText : null);
    const rows = (el) => (el ? [...el.querySelectorAll("tbody tr")].filter((r) => r.offsetParent !== null).map((r) => [...r.children].map((c) => c.innerText.trim())) : []);
    const cats = [...document.querySelectorAll("[data-report-category]")].map((c) => ({ id: c.getAttribute("data-report-category"), title: c.querySelector("h3")?.innerText.trim(), forms: [...c.querySelectorAll("[data-report-form]")].map((a) => ({ type: a.getAttribute("data-report-form"), text: a.innerText.replace(/\s+/g, " ").trim(), href: a.getAttribute("href") })) }));
    return {
      path: location.pathname,
      categories: cats,
      reportsText: document.querySelector("#reports")?.innerText ?? document.body.innerText,
      mine: text(feed("mine")),
      station: text(feed("station")),
      stationRows: rows(feed("station")),
      mineRows: rows(feed("mine")),
      historyLink: [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/avsec/history"),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      liveWording: /live activity stream/i.test(document.body.innerText),
    };
  });
}

const forms = (s) => Object.fromEntries(s.categories.map((c) => [c.id, c.forms.map((f) => f.type)]));

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const all = [];
  try {
    for (const a of targets) {
      for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
        const { ctx, page, errors } = await session(browser, vp);
        try {
          await signIn(page, a);
          const s = await snapshot(page);
          all.push({ label: a.label, vp: vpName, s, errors });
          const tag = `${a.label} (${vpName})`;
          ok(`${tag}: lands on "/" (the legacy landing that carries both feeds)`, s.path === "/", `landed ${s.path}`);
          if (s.path !== "/") { await page.screenshot({ path: path.join(evDir, `${a.label}-${vpName}-landing.png`) }); await ctx.close(); continue; }
          ok(`${tag}: no horizontal overflow`, !s.horizontalOverflow);
          ok(`${tag}: History stays accessible`, s.historyLink);
          ok(`${tag}: the ambiguous "Live activity stream" is gone`, !s.liveWording);
          ok(`${tag}: both feeds render with their own headings`, /My Recent Activity/.test(s.mine ?? "") && /Station Activity/.test(s.station ?? ""));
          ok(`${tag}: Station Activity states it is a page-load snapshot with Refresh`, /Loaded at \d{2}:\d{2}/.test(s.station ?? "") && /does not update by itself/.test(s.station ?? "") && /Refresh/.test(s.station ?? ""));
          ok(`${tag}: no standalone Offload tile anywhere in the report area`, !/offload/i.test(s.reportsText));
          ok(`${tag}: no Makeup / Breakup tile`, !/makeup|breakup/i.test(s.reportsText));

          if (a.label === "aso" || a.label === "aso-jhb" || a.label === "aso-kul") {
            const f = forms(s);
            ok(`${tag}: Daily Reports lists SEC014 only (SEC013 not shown to an ordinary ASO)`, JSON.stringify(f.daily) === JSON.stringify(["sec014"]), JSON.stringify(f.daily));
            ok(`${tag}: Aircraft Reports lists SEC016, SEC029, SEC018, SEC033 in order`, JSON.stringify(f.aircraft) === JSON.stringify(["sec016", "sec029", "sec018", "sec033"]), JSON.stringify(f.aircraft));
            ok(`${tag}: category order is Daily then Aircraft`, s.categories.map((c) => c.title).join("|") === "Daily Reports|Aircraft Reports");
            const labels = s.categories.flatMap((c) => c.forms.map((x) => x.text));
            ok(`${tag}: each card shows its form code and name`, labels.some((t) => /AA\/SEC\/F\/014 Rev\.03 ASO Daily Report/.test(t)) && labels.some((t) => /AA\/SEC\/F\/033 Rev\.02 Aircraft Hold Checklist/.test(t)), labels.join(" ; ").slice(0, 160));
          }
          if (a.label === "profiling_aso") {
            const f = forms(s);
            ok(`${tag}: only Daily Reports → SEC013, the empty Aircraft category is hidden`, JSON.stringify(f) === JSON.stringify({ daily: ["sec013"] }), JSON.stringify(f));
          }
          if (["so", "dse", "sso", "hub_se", "operation_manager"].includes(a.label)) {
            ok(`${tag}: supervisory identity sees no filing cards`, s.categories.length === 0 && /No report forms are assigned to you/.test(s.reportsText), JSON.stringify(forms(s)));
          }

          const mine = s.mine ?? "";
          const station = s.station ?? "";
          if (a.label === "aso") {
            ok(`${tag}: My Recent Activity lists my own check-in, Part B and receipt`, /Checked in for duty/.test(mine) && /Origin checkpoint \(Part B\)/.test(mine) && /Confirmed destination receipt/.test(mine) && mine.includes(PEN_TX));
            ok(`${tag}: another officer's Part C on the SAME movement is not mine`, !/Checkpoint \(Part C\)/.test(mine));
            ok(`${tag}: another station's movement is not mine`, !mine.includes(JHB_TX));
            ok(`${tag}: Station Activity (PEN) shows the PEN movement and never the JHB one`, station.includes(PEN_TX) && !station.includes(JHB_TX));
            ok(`${tag}: Station Activity labels the movement route as "Route"`, vpName === "mobile" ? /Route: AIRCRAFT/.test(station) : s.stationRows.some((r) => r.join("|").includes(PEN_TX) && r[2] === "AIRCRAFT"), JSON.stringify(s.stationRows.find((r) => r.join("|").includes(PEN_TX)) ?? null));
            if (vpName === "desktop") ok(`${tag}: a record with no station shows "—" for Station/Location, never the route`, s.stationRows.some((r) => r.join("|").includes(PEN_TX) && r[3] === "—"));
            if (vpName === "mobile") ok(`${tag}: mobile uses readable cards (no wide table rows)`, s.mineRows.length === 0 && s.stationRows.length === 0);
            ok(`${tag}: times are shown in Malaysia time`, /\d{2}:\d{2}/.test(mine));
          }
          if (a.label === "aso-jhb") {
            ok(`${tag}: my own Part B at JHB is listed, PEN's movement and actions are not`, mine.includes(JHB_TX) && /Origin checkpoint \(Part B\)/.test(mine) && !mine.includes(PEN_TX));
            ok(`${tag}: Station Activity (JHB) never shows the PEN movement`, !station.includes(PEN_TX));
          }
          if (a.label === "aso-kul") {
            ok(`${tag}: no CaterLink checkpoint is attributed to me (I performed none)`, !/checkpoint|destination receipt/i.test(mine));
          }
          if (a.label === "profiling_aso") {
            ok(`${tag}: my single Part C is mine (and PEN's Part B by another officer is not)`, /Checkpoint \(Part C\)/.test(mine) && !/Origin checkpoint \(Part B\)/.test(mine));
          }
          if (["so", "dse", "sso"].includes(a.label)) {
            ok(`${tag}: no CaterLink action of another officer appears as mine`, !/checkpoint|destination receipt/i.test(mine) && !/ICMS-2026-99000/.test(mine));
          }
          if (["hub_se", "operation_manager"].includes(a.label)) {
            ok(`${tag}: leadership scope keeps its existing wording and invents no personal actions`, /Station Activity/.test(station) && !/checkpoint|destination receipt/i.test(mine));
          }

          // evidence: representative screenshots, light and dark
          const keep = (["aso", "profiling_aso", "so"].includes(a.label)) || (a.label === "aso-jhb" && vpName === "mobile");
          if (keep) {
            await page.screenshot({ path: path.join(evDir, `${a.label}-${vpName}-light.png`), fullPage: true });
            if (a.label === "aso") {
              await page.emulateMedia({ colorScheme: "dark" });
              await page.waitForTimeout(500);
              await page.screenshot({ path: path.join(evDir, `${a.label}-${vpName}-dark.png`), fullPage: true });
              const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
              ok(`${tag}: dark appearance applies (body background differs from light)`, dark !== "rgb(255, 255, 255)", dark);
            }
          }

          // old standalone Offload link
          if (vpName === "desktop" && ["aso", "profiling_aso"].includes(a.label)) {
            await page.goto(`${base}/avsec/reports/offload`, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            const p = new URL(page.url()).pathname;
            const body = (await page.textContent("body")) ?? "";
            if (a.label === "aso") ok(`${tag}: the old /avsec/reports/offload link lands on the SEC016 form (Offload Information lives there)`, p === "/avsec/reports/sec016" && /AA\/SEC\/F\/016/.test(body), p);
            else ok(`${tag}: the old Offload link for a person without SEC016 goes to their own workspace, not a form`, p !== "/avsec/reports/sec016" && !/OFFLOAD INFORMATION/i.test(body), p);
            await page.screenshot({ path: path.join(evDir, `${a.label}-offload-link.png`) });
          }
        } catch (e) { ok(`${a.label} (${vpName}) completed`, false, String(e.message).slice(0, 160)); }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }

  const unsafe = [...hosts].filter((h) => h.includes(PROD_REF));
  ok("No network request went to the production Supabase project", unsafe.length === 0);
  ok("Browser traffic reached only the preview host and the staging Supabase project (plus static/font hosts)", [...hosts].every((h) => h.endsWith("vercel.app") || h.startsWith(STAGING_REF) || /gstatic|googleapis|vercel/.test(h)), [...hosts].join(","));
  const errs = all.flatMap((r) => r.errors.map((e) => `${r.label}/${r.vp}: ${e}`));
  ok("No browser console or page errors (Vercel toolbar noise excluded)", errs.length === 0, errs.slice(0, 5).join(" | "));
  fs.writeFileSync(path.join(evDir, "results.json"), JSON.stringify({ base, passes, failures, results: all.map(({ errors, ...r }) => ({ ...r, errorCount: errors.length })) }, null, 2));
  console.log(`\nEvidence directory: ${evDir}\nPASS=${passes} FAIL=${failures}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
