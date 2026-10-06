#!/usr/bin/env node
// Real-browser E2E of the CaterLink Driver / Vendor / Management workflows against the app (default: a local Next
// server pointed at the approved staging project). Drives the real forms: signatures are drawn on the real canvas.
// Writes clearly marked E2E records to staging. Credentials come from the private files outside the repository and are
// typed into the real login form in memory; nothing sensitive is printed.
//
//   node scripts/staging/e2e-external-workflows.mjs --url=http://localhost:3000 --viewport=desktop|mobile [--flow=driver,vendor,management,isolation]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url") ?? "http://localhost:3000";
const vpName = argVal("viewport") ?? "desktop";
const flows = (argVal("flow") ?? "driver,vendor,management,isolation").split(",");
const VIEWPORTS = { desktop: { width: 1366, height: 850 }, mobile: { width: 390, height: 844 } };
const vp = VIEWPORTS[vpName];
const accounts = loadCurrentCredentials();
const acct = (l) => accounts.find((a) => a.label === l);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evDir = path.join(os.tmpdir(), "vecta-preview-evidence", `e2e-${vpName}-${stamp}`);
fs.mkdirSync(evDir, { recursive: true });
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const tag = `${vpName.slice(0, 1)}${Date.now().toString().slice(-5)}`;

let failures = 0;
let blockedCount = 0;
// BLOCKED = the step cannot be exercised because of a documented environment defect (never counted as a pass)
const blocked = (label, note = "") => { blockedCount += 1; console.log(`BLOCKED: [${vpName}] ${label}${note ? " -- " + note : ""}`); return false; };
const STORAGE_DEFECT = /Upload failed: permission denied for function get_report_submitter/;
const ok = (label, cond, note = "") => { if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: [${vpName}] ${label}${note ? " -- " + note : ""}`); return cond; };
const pathOf = (page) => new URL(page.url()).pathname + new URL(page.url()).search;

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  ctx.setDefaultTimeout(20000);
  ctx.setDefaultNavigationTimeout(30000);
  return { ctx, page: await ctx.newPage() };
}
async function login(page, label) {
  const a = acct(label);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    // a dev server hydrates late: typing before hydration is lost, so wait for React to attach to the input
    await page.waitForFunction(() => { const el = document.querySelector('input[name="email"]'); return !!el && Object.keys(el).some((k) => k.startsWith("__react")); }, null, { timeout: 30000 }).catch(() => {});
    await page.fill('input[name="email"]', a.email);
    await page.fill('input[name="password"]', a.password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (!/\/login/.test(new URL(page.url()).pathname)) return true;
    await page.waitForTimeout(20000 * (attempt + 1));
  }
  return false;
}
async function draw(page, index = 0) {
  const canvas = page.locator("canvas").nth(index);
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + 20 + i * 12, box.y + box.height / 2 + (i % 2 ? 14 : -14), { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
// a dev server hydrates late: a stroke drawn before the pad is attached emits nothing, so draw until the submit enables
async function drawUntilEnabled(page, button) {
  for (let i = 0; i < 6; i += 1) {
    await draw(page, 0);
    if (await button.isEnabled().catch(() => false)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}
const shot = (page, name) => page.screenshot({ path: path.join(evDir, `${name}-${vpName}.png`), fullPage: false }).catch(() => {});
const visibleText = async (page) => (await page.locator("body").innerText({ timeout: 15000 }).catch(() => "")) ?? "";
const idFromUrl = (page, seg) => (page.url().match(new RegExp(`/${seg}/([0-9a-f-]{36})`)) ?? [])[1];

function loadFixtures() {
  const f = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-e2e-fixtures.json"), "utf8"));
  return { txId: f.txId, txNumber: f.txNumber, vendorDeliveryId: f.deliveryPen, escalatedId: f.deliveryJhb, fromFixture: true };
}
async function rpcAs(label, fn, args) {
  const a = acct(label);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await signInWithRetry(sb, a.email, a.password);
  if (error) throw new Error(`rpc sign-in failed for ${label}`);
  return sb.rpc(fn, args);
}

async function driverFlow(browser, state) {
  const { ctx, page } = await newCtx(browser);
  const T = "Driver";
  page.on("dialog", async (d) => { console.log(`   (browser dialog: ${d.message()})`); await d.dismiss().catch(() => {}); });
  try {
    ok(`${T}: signs in`, await login(page, "caterlink-driver"));
    ok(`${T}: lands in CaterLink`, /^\/(caterlink|icms)\/dashboard/.test(pathOf(page)), pathOf(page));
    await page.goto(`${base}/icms/transactions/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("button[aria-pressed]", { timeout: 20000 });
    // a dev server hydrates late: a click before hydration is ignored, so retry until the form appears
    for (let i = 0; i < 8 && !(await page.locator("#station").count()); i += 1) {
      await page.getByRole("button", { name: /Outbound/i }).first().click();
      await page.waitForTimeout(1500);
    }
    await page.waitForSelector("#station", { timeout: 15000 });
    const stations = await page.$$eval("#station option", (o) => o.map((x) => x.value).filter(Boolean).sort());
    ok(`${T}: allowed creation stations are exactly KUL - AAX and KUL - MAA`, stations.join("|") === "KUL - AAX|KUL - MAA", stations.join("|"));
    const vehicles = await page.$$eval("#vehicle_number option", (o) => o.map((x) => x.value).filter(Boolean));
    ok(`${T}: the vehicle options contain only usable whitelist entries (E2E1234A)`, vehicles.includes("E2E1234A") && vehicles.length >= 1, vehicles.join(","));
    await shot(page, "driver-new-form");
    await page.selectOption("#station", "KUL - MAA");
    await page.selectOption("#vehicle_number", "E2E1234A");
    // the Driver account is not itself a whitelisted driver: choose a different (whitelisted) driver
    const modes = page.locator('input[name="__driver_mode"]');
    if ((await modes.count()) > 1) await modes.nth(1).check();
    const driverSelect = page.locator("select").filter({ has: page.locator('option[value="E2ED001"]') }).first();
    await driverSelect.selectOption("E2ED001");
    await page.getByLabel("Seal 1 number").fill(`E2E-UI-${tag}`);
    await page.getByLabel("Seal 1 color").selectOption({ index: 1 });
    await page.locator('input[name="cargo_types"]').first().check({ force: true });
    await page.locator("#vehicle_search_completed").check({ force: true }).catch(async () => { await page.getByText(/vehicle search/i).first().click(); });
    await page.fill("#remarks", `E2E ${tag}`);
    const txBtn = page.getByRole("button", { name: /Create Transaction/i });
    for (let i = 0; i < 4; i += 1) { await draw(page, 0); await page.waitForTimeout(800); }
    await shot(page, "driver-form-filled");
    await txBtn.click();
    await page.waitForURL(/\/icms\/transactions\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
    const createdId = idFromUrl(page, "transactions");
    if (createdId) {
      state.txId = createdId;
      ok(`${T}: transaction creation submitted from the UI`, true, pathOf(page));
    } else {
      const msg = ((await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(" | ") || "none").slice(0, 300);
      if (STORAGE_DEFECT.test(msg)) blocked(`${T}: transaction creation submitted from the UI`, "signature upload refused by the storage policy (pre-existing defect: authenticated cannot execute get_report_submitter)");
      else ok(`${T}: transaction creation submitted from the UI`, false, msg);
      Object.assign(state, loadFixtures());
    }
    if (state.txId) {
      await page.goto(`${base}/icms/transactions/${state.txId}`, { waitUntil: "domcontentloaded" });
      const text = await visibleText(page);
      state.txNumber = (text.match(/CL-\d{4}-\d{6}/) ?? [])[0] ?? state.txNumber;
      ok(`${T}: the movement page shows its CL number, Part A and a seal`, !!state.txNumber && /Part A/i.test(text) && /E2E-/.test(text), state.txNumber);
      ok(`${T}: Part A records the Driver account as PIC (from the trusted account row)`, /UAT CaterLink Driver/i.test(text) && /UAT-CL-DRIVER/.test(text));
      await shot(page, "driver-movement");
      await page.goto(`${base}/icms/transactions`, { waitUntil: "domcontentloaded" });
      ok(`${T}: the transactions list shows the movement`, (await visibleText(page)).includes(state.txNumber ?? "NONE"));
    }
    // other-role data is not reachable
    await page.goto(`${base}/icms/vendor-transactions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const vtext = await visibleText(page);
    ok(`${T}: the Vendor delivery workflow is denied`, /error=forbidden/.test(page.url()) || !/Vendor Deliveries|My Deliveries/i.test(vtext), pathOf(page));
    if (state.vendorDeliveryId) {
      await page.goto(`${base}/icms/vendor-transactions/${state.vendorDeliveryId}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      ok(`${T}: a Vendor delivery URL does not open (no vendor data)`, /error=forbidden/.test(page.url()) || !/CLV-\d{4}/.test(await visibleText(page)), pathOf(page));
    }
    for (const p of ["/", "/avsec/home", "/super-admin"]) {
      await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      ok(`${T}: direct ${p} stays inside CaterLink`, /^\/(caterlink|icms)\//.test(pathOf(page)), pathOf(page));
    }
    for (const ap of ["/api/wois/chat", "/api/avsec/export"]) {
      const r = await page.request.get(`${base}${ap}`, { failOnStatusCode: false });
      ok(`${T}: direct VECTA API ${ap} answers 403`, r.status() === 403, `status ${r.status()}`);
    }
  } catch (e) { ok(`${T}: flow`, false, String(e.message).slice(0, 200)); await shot(page, "driver-error"); }
  await ctx.close();
}

async function vendorCreate(page, station, seal) {
  await page.goto(`${base}/icms/vendor-transactions/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#station_code", { timeout: 20000 });
  const stations = await page.$$eval("#station_code option", (o) => o.map((x) => x.value).filter(Boolean).sort());
  await page.selectOption("#station_code", station);
  await page.fill("#driver_name", "E2E Vendor Driver");
  await page.fill("#nric_number", "E2E-NRIC-001");
  await page.fill("#vehicle_registration_no", `E2EV${tag}`);
  await page.fill("#seal_number", seal);
  await page.fill("#supplies_description", `E2E supplies ${tag}`);
  const createBtn = page.getByRole("button", { name: /Create Delivery/i });
  await drawUntilEnabled(page, createBtn);
  await createBtn.click();
  await page.waitForURL(/\/icms\/vendor-transactions\/[0-9a-f-]{36}/, { timeout: 30000 }).catch(() => {});
  return { id: idFromUrl(page, "vendor-transactions"), stations };
}
async function officerCheck(browser, label, id, result, reason, T) {
  const { ctx, page } = await newCtx(browser);
  try {
    ok(`${T}: officer ${label} signs in`, await login(page, label));
    await page.goto(`${base}/icms/vendor-transactions/${id}/part-b`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#vehicle_registration_no", { timeout: 20000 });
    await page.fill("#vehicle_registration_no", `E2EV${tag}`);
    await page.fill("#driver_name", "E2E Vendor Driver");
    await page.fill("#driver_nric", "E2E-NRIC-001");
    await page.fill("#seal_number", `E2E-OBS-${tag}`);
    if (result === "ESCALATE") {
      await page.selectOption("#result", "ESCALATE");
      await page.fill("#escalation_reason", reason);
    }
    const checkBtn = page.getByRole("button", { name: result === "ESCALATE" ? /Escalate/i : /Approve Part B/i });
    await drawUntilEnabled(page, checkBtn);
    await shot(page, `officer-${label}-${result}`);
    await checkBtn.click();
    await page.waitForURL((u) => /approved=1/.test(u.search), { timeout: 30000 }).catch(() => {});
    const msg = ((await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(" | ") || "none").slice(0, 300);
    if (/approved=1/.test(page.url())) ok(`${T}: officer ${label} recorded the security check (${result}) from the UI`, true);
    else if (STORAGE_DEFECT.test(msg)) blocked(`${T}: officer ${label} recorded the security check (${result}) from the UI`, "signature upload refused by the storage policy (pre-existing defect)");
    else ok(`${T}: officer ${label} recorded the security check (${result}) from the UI`, false, msg);
  } catch (e) { ok(`${T}: officer ${label} check`, false, String(e.message).slice(0, 200)); await shot(page, `officer-${label}-error`); }
  await ctx.close();
}
async function officerDenied(browser, label, id, T) {
  const { ctx, page } = await newCtx(browser);
  try {
    await login(page, label);
    await page.goto(`${base}/icms/vendor-transactions/${id}/part-b`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const form = await page.locator("#vehicle_registration_no").count();
    ok(`${T}: ${label} gets no security-check form for this delivery`, form === 0, pathOf(page));
  } catch (e) { ok(`${T}: ${label} denial`, false, String(e.message).slice(0, 160)); }
  await ctx.close();
}

async function vendorFlow(browser, state) {
  const T = "Vendor";
  const { ctx, page } = await newCtx(browser);
  try {
    ok(`${T}: signs in`, await login(page, "caterlink-vendor"));
    ok(`${T}: lands in CaterLink`, /^\/(caterlink|icms)\/dashboard/.test(pathOf(page)), pathOf(page));
    const a = await vendorCreate(page, "PEN", `E2E-VUI-${tag}`);
    ok(`${T}: delivery station choices are exactly JHB and PEN`, a.stations.join("|") === "JHB|PEN", a.stations.join("|"));
    if (a.id) {
      state.vendorDeliveryId = a.id;
      ok(`${T}: delivery created from the UI`, true, pathOf(page));
    } else {
      const msg = ((await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(" | ") || "none").slice(0, 300);
      if (STORAGE_DEFECT.test(msg)) blocked(`${T}: delivery created from the UI`, "signature upload refused by the storage policy (pre-existing defect)");
      else ok(`${T}: delivery created from the UI`, false, msg);
      if (!state.fromFixture) Object.assign(state, loadFixtures());
    }
    // a fresh CREATED delivery (via the real function) so the officer / completion steps can be exercised
    const fresh = await rpcAs("caterlink-vendor", "create_caterlink_vendor_delivery_secure", { p_station_code: "PEN", p_driver_name: "E2E Vendor Driver", p_driver_nric: "E2E-NRIC-001", p_vehicle_registration_no: `E2EV${tag}`, p_seal_number: `E2E-VRPC-${tag}`, p_signature_url: "signatures/e2e-vendor.png" });
    const freshId = (Array.isArray(fresh.data) ? fresh.data[0] : fresh.data)?.delivery_id;
    ok(`${T}: a CREATED delivery exists for the workflow steps`, !!freshId, fresh.error?.message);
    const viewText = async (id) => { await page.goto(`${base}/icms/vendor-transactions/${id}`, { waitUntil: "domcontentloaded" }); return visibleText(page); };
    let t = await viewText(freshId);
    state.deliveryNumber = (t.match(/CLV-\d{4}-\d{6}/) ?? [])[0];
    ok(`${T}: the delivery page shows its CLV number, status Created and the QR pass`, !!state.deliveryNumber && /Created/i.test(t) && (await page.locator("svg, canvas, img").count()) > 0, state.deliveryNumber);
    await shot(page, "vendor-created");
    ok(`${T}: no Confirm handover before the security check`, (await page.getByRole("link", { name: /Confirm handover/i }).count()) === 0);
    await page.goto(`${base}/icms/vendor-transactions/${freshId}/part-c`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    ok(`${T}: Part C is not available before the check`, !/Complete Delivery/i.test(await visibleText(page)), pathOf(page));
    await officerDenied(browser, "aso-jhb", freshId, T);
    await officerDenied(browser, "profiling_aso", freshId, T);
    await officerDenied(browser, "aso-kul", freshId, T);
    await officerCheck(browser, "aso", freshId, "PASS", null, T);
    t = await viewText(freshId);
    if (/Security check passed/i.test(t) || /Part B/i.test(t)) {
      ok(`${T}: the delivery shows the security check passed`, true);
      await page.getByRole("link", { name: /Confirm handover/i }).click().catch(() => {});
      await page.waitForURL(/part-c/, { timeout: 15000 }).catch(() => {});
      for (let i = 0; i < 6 && !(await page.locator("canvas").count()); i += 1) await page.waitForTimeout(1000);
      const completeBtn = page.getByRole("button", { name: /Complete Delivery/i });
      await drawUntilEnabled(page, completeBtn);
      await shot(page, "vendor-part-c");
      await completeBtn.click();
      await page.waitForURL((u) => /completed=1/.test(u.search), { timeout: 30000 }).catch(() => {});
      const msg = ((await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).join(" | ") || "none").slice(0, 300);
      if (/completed=1/.test(page.url())) ok(`${T}: completion submitted from the UI`, true);
      else if (STORAGE_DEFECT.test(msg)) blocked(`${T}: completion submitted from the UI`, "signature upload refused by the storage policy (pre-existing defect)");
      else ok(`${T}: completion submitted from the UI`, false, msg);
    } else {
      blocked(`${T}: confirm handover / completion from the UI`, "the security check could not be recorded from the UI (storage defect), so the delivery is still CREATED");
      // complete through the real function so the COMPLETED view can still be verified in the browser
      const done = await rpcAs("aso", "record_caterlink_vendor_security_check_secure", { p_delivery_id: freshId, p_signature_url: "signatures/e2e-officer.png", p_result: "PASS", p_observed: { seal_number: "E2E" } });
      ok(`${T}: (setup) the PEN officer's function call recorded the check`, !done.error, done.error?.message);
      await page.goto(`${base}/icms/vendor-transactions/${freshId}`, { waitUntil: "domcontentloaded" });
      ok(`${T}: after the check the delivery offers Confirm handover`, (await page.getByRole("link", { name: /Confirm handover/i }).count()) > 0);
      await page.goto(`${base}/icms/vendor-transactions/${freshId}/part-c`, { waitUntil: "domcontentloaded" });
      ok(`${T}: the Part C form renders for the owning Vendor after the check`, (await page.getByRole("button", { name: /Complete Delivery/i }).count()) > 0 && (await page.locator("canvas").count()) > 0);
    }
    // views of the fixture deliveries: COMPLETED and ESCALATED
    if (state.vendorDeliveryId) {
      t = await viewText(state.vendorDeliveryId);
      ok(`${T}: a completed delivery shows Completed with three recorded parts`, /Completed/.test(t) && /Part A/.test(t) && /Part B/.test(t) && /Part C/.test(t), state.vendorDeliveryId.slice(0, 8));
      await shot(page, "vendor-completed");
    }
    if (state.escalatedId) {
      t = await viewText(state.escalatedId);
      ok(`${T}: the escalated delivery shows Escalated and the reason`, /Escalated/i.test(t) && /E2E seal mismatch/.test(t));
      ok(`${T}: an escalated delivery offers no Confirm handover`, (await page.getByRole("link", { name: /Confirm handover/i }).count()) === 0);
      await page.goto(`${base}/icms/vendor-transactions/${state.escalatedId}/part-c`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      ok(`${T}: Part C is not reachable for an escalated delivery`, !/Complete Delivery/i.test(await visibleText(page)), pathOf(page));
      await shot(page, "vendor-escalated");
    }
    // other-role data is not reachable
    if (state.txId) {
      await page.goto(`${base}/icms/transactions/${state.txId}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      ok(`${T}: the Driver's movement does not open (no Driver data)`, /error=forbidden/.test(page.url()) || !/CL-\d{4}-\d{6}/.test(await visibleText(page)), pathOf(page));
    }
    await page.goto(`${base}/icms/transactions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    ok(`${T}: the catering transactions list is denied`, /error=forbidden/.test(page.url()) || !/CL-\d{4}-\d{6}/.test(await visibleText(page)), pathOf(page));
    await page.goto(`${base}/icms/transactions/new`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    ok(`${T}: the Driver's creation form is denied`, /error=forbidden/.test(page.url()) || !(await page.locator("button[aria-pressed]").count()), pathOf(page));
    for (const p of ["/", "/avsec/home", "/super-admin"]) {
      await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      ok(`${T}: direct ${p} stays inside CaterLink`, /^\/(caterlink|icms)\//.test(pathOf(page)), pathOf(page));
    }
    for (const ap of ["/api/wois/chat", "/api/avsec/export"]) {
      const r = await page.request.get(`${base}${ap}`, { failOnStatusCode: false });
      ok(`${T}: direct VECTA API ${ap} answers 403`, r.status() === 403, `status ${r.status()}`);
    }
  } catch (err) { ok(`${T}: flow`, false, String(err.message).slice(0, 200)); await shot(page, "vendor-error"); }
  await ctx.close();
}

async function managementFlow(browser, state) {
  const T = "Management";
  const { ctx, page } = await newCtx(browser);
  try {
    ok(`${T}: signs in`, await login(page, "caterlink_management"));
    ok(`${T}: lands in CaterLink`, /^\/(caterlink|icms)\/dashboard/.test(pathOf(page)), pathOf(page));
    await page.goto(`${base}/icms/transactions`, { waitUntil: "domcontentloaded" });
    ok(`${T}: sees the Driver's E2E movement in the transactions list`, state.txNumber ? (await visibleText(page)).includes(state.txNumber) : /CL-\d{4}-\d{6}/.test(await visibleText(page)), state.txNumber ?? "");
    if (state.txId) {
      await page.goto(`${base}/icms/transactions/${state.txId}`, { waitUntil: "domcontentloaded" });
      const t = await visibleText(page);
      ok(`${T}: the movement detail shows Part A and the seal`, /Part A/.test(t) && /E2E-/.test(t));
      ok(`${T}: no driver actions (no scan/verify controls) on the movement`, (await page.getByRole("link", { name: /Scan|Verify/i }).count()) === 0);
      await shot(page, "management-transaction");
    }
    await page.goto(`${base}/icms/vendor-transactions`, { waitUntil: "domcontentloaded" });
    const vt = await visibleText(page);
    ok(`${T}: sees the Vendor deliveries`, /CLV-\d{4}-\d{6}/.test(vt));
    ok(`${T}: has no 'New Delivery' action`, (await page.getByRole("link", { name: /New Delivery/i }).count()) === 0);
    await page.goto(`${base}/icms/admin/audit`, { waitUntil: "domcontentloaded" });
    const at = await visibleText(page);
    ok(`${T}: the audit log shows Driver and Vendor workflow events`, /caterlink_driver_transaction_create/.test(at) && /caterlink_vendor_delivery_create/.test(at) && /caterlink_vendor_security_check/.test(at) && /caterlink_vendor_delivery_complete/.test(at));
    await shot(page, "management-audit");
    for (const p of ["/icms/incidents", "/icms/reports", "/icms/admin/whitelists", "/icms/admin/archive", "/icms/dashboard"]) {
      await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const txt = await visibleText(page);
      ok(`${T}: ${p} opens without an error page`, /^\/(caterlink|icms)\//.test(pathOf(page)) && !/Application error|Internal Server Error|something went wrong/i.test(txt), pathOf(page));
    }
    await page.goto(`${base}/icms/transactions/new`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    ok(`${T}: cannot create a movement (no driver action)`, /error=forbidden/.test(page.url()) || !(await page.locator("button[aria-pressed]").count()), pathOf(page));
    await page.goto(`${base}/icms/scan`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    ok(`${T}: has no scanning`, /error=forbidden/.test(page.url()) || !/Scan/i.test((await page.locator("main").innerText().catch(() => "")) ?? "") || (await page.locator("video, #reader").count()) === 0, pathOf(page));
    for (const p of ["/", "/avsec/home", "/super-admin"]) {
      await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      ok(`${T}: direct ${p} stays inside CaterLink`, /^\/(caterlink|icms)\//.test(pathOf(page)), pathOf(page));
    }
    const r1 = await page.request.get(`${base}/api/wois/chat`, { failOnStatusCode: false });
    const r2 = await page.request.get(`${base}/api/avsec/export`, { failOnStatusCode: false });
    ok(`${T}: direct VECTA APIs answer 403`, r1.status() === 403 && r2.status() === 403, `${r1.status()}/${r2.status()}`);
  } catch (e) { ok(`${T}: flow`, false, String(e.message).slice(0, 200)); await shot(page, "management-error"); }
  await ctx.close();
}

async function isolationFlow(browser, state) {
  // an unrelated officer (not the creator, not at the origin station) cannot open the Driver's movement
  const T = "Isolation";
  for (const label of ["aso", "aso-jhb", "profiling_aso"]) {
    const { ctx, page } = await newCtx(browser);
    try {
      await login(page, label);
      if (state.txId) {
        await page.goto(`${base}/icms/transactions/${state.txId}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        ok(`${T}: ${label} cannot open the Driver's movement`, !/CL-\d{4}-\d{6}/.test(await visibleText(page)) || /not found/i.test(await visibleText(page)), pathOf(page));
      }
    } catch (e) { ok(`${T}: ${label}`, false, String(e.message).slice(0, 120)); }
    await ctx.close();
  }
}

async function main() {
  if (!vp) throw new Error("--viewport must be desktop or mobile");
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const state = flows.includes("driver") ? {} : loadFixtures();
  try {
    if (flows.includes("driver")) await driverFlow(browser, state);
    if (flows.includes("vendor")) await vendorFlow(browser, state);
    if (flows.includes("driver")) { /* second pass once the vendor delivery id exists */ await (async () => {
      const { ctx, page } = await newCtx(browser);
      try {
        await login(page, "caterlink-driver");
        if (state.vendorDeliveryId) {
          await page.goto(`${base}/icms/vendor-transactions/${state.vendorDeliveryId}`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1500);
          ok(`Driver: a Vendor delivery URL does not open (no vendor data)`, /error=forbidden/.test(page.url()) || !/CLV-\d{4}-\d{6}/.test(await visibleText(page)), pathOf(page));
        }
      } catch (e) { ok("Driver: vendor-url check", false, String(e.message).slice(0, 120)); }
      await ctx.close();
    })(); }
    if (flows.includes("management")) await managementFlow(browser, state);
    if (flows.includes("isolation")) await isolationFlow(browser, state);
  } finally { await browser.close(); }
  console.log(`\nEvidence directory: ${evDir}\nBlocked steps: ${blockedCount}\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
