#!/usr/bin/env node
// Targeted CaterLink Part B certification against the tagged Part B fixtures (staging only). NOT a UAT run.
//   node --env-file=.env.local --experimental-strip-types --experimental-loader ./tests/loader.mts scripts/staging/targeted-part-b-probe.mjs \
//        --url=<preview> --run-id=<run id that holds create-partb AND create-duty fixtures> [--browser=0]
// Prints sanitized evidence only: pass/fail, statuses, outcomes and counts. No credentials, tokens, e-mails or response bodies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest } from "./lib/review-accounts.mjs";
import { nextStepFor } from "../../lib/icms/workflow.ts";
import { bound, uploadBound, cleanupOwnOrphans, SetupError } from "./lib/signature-fixtures.mjs";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
// a fixture/setup fault is INCONCLUSIVE (exit 2), never a pass and never a failed control
const inconclusive = (e) => { if (e instanceof SetupError || e?.name === "SetupError") { console.error("INCONCLUSIVE (fixture/setup fault, not an authorization verdict):", e.message); process.exit(2); } console.error(e); process.exit(1); };
process.on("uncaughtException", inconclusive);
process.on("unhandledRejection", inconclusive);

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
if (!base || !runId) throw new Error("--url and --run-id are required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) throw new Error("production reference present");
const ledger = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-uat-fixtures", `${runId}.json`), "utf8"));
const P = ledger.partb ?? (() => { throw new Error("the ledger holds no Part B fixtures"); })();
const TX = Object.fromEntries(ledger.tx.map((t) => [t.key, t]));
const manifest = loadCurrentManifest();
const creds = loadCurrentCredentials();
let fails = 0;
const ok = (label, cond, note = "") => { if (!cond) fails += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { client } = await connectVerified();
const q = async (s, p) => (await client.query(s, p)).rows;
const snap = async (tx) => ({
  status: (await q("select status from public.transactions where id = $1", [tx.id]))[0]?.status,
  partB: (await q("select count(*)::int n from public.part_b_c where transaction_id = $1", [tx.id]))[0].n,
  incidents: (await q("select count(*)::int n from public.caterlink_incidents where transaction_id = $1", [tx.id]))[0].n,
  audit: (await q("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_part_b_record'", [tx.id]))[0].n,
  verifs: (await q("select count(*)::int n from public.seal_verifications where seal_id = $1", [tx.sealId]))[0].n,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ REST path (the real PostgREST + RPC, as each signed-in user)
const sessions = {};
async function rest(label) {
  if (sessions[label]) return sessions[label];
  const a = creds.find((x) => x.label === label) ?? (() => { throw new Error(`no credentials for ${label}`); })();
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: a.email, password: a.password });
  if (error) throw new Error(`${label}: sign-in failed (${error.status ?? "?"})`);
  await sleep(2500);
  return (sessions[label] = c);
}
// Two gates guard a Part B signature (migration 20261113000001): Storage RLS on the upload, then the RPC. The refusal probes call the RPC alone
// with a well-formed parent-bound path (no object): the RPC authorises BEFORE it looks at the signature, so its uniform refusal is what is
// compared. The success and concurrency paths upload a real object through the officer's OWN session first (callUploaded).
const rpcArgs = (tx, o, sig) => ({
  p_transaction_id: tx.id, p_vehicle_verified: o.veh ?? true, p_driver_verified: o.drv ?? true,
  p_seal_entries: o.entries ?? { [tx.sealId]: P.sealNumber }, p_seal_colors: o.colors ?? { [tx.sealId]: "BLUE" },
  p_observed_vehicle: o.vehicle ?? P.vehicleNumber, p_observed_driver_name: o.dname ?? P.driverName, p_observed_driver_id: o.did ?? P.driverStaffId,
  p_signature_url: sig, p_signature_hash: "a".repeat(64), p_remarks: "", p_result: o.result ?? "PASS", p_escalation_reason: o.reason ?? "",
});
async function callUploaded(c, tx, o = {}) {
  const up = await uploadBound({ sb: c }, bound.partB(tx.id));
  if (up.outcome === "setup") throw new SetupError(`fixture signature could not be uploaded: ${String(up.error?.message ?? "").slice(0, 100)}`);
  if (up.outcome === "authorization") return { error: up.error, data: null, stage: "upload" };
  return c.rpc("record_caterlink_part_b_secure", rpcArgs(tx, o, up.path));
}
const call = (c, tx, o = {}) => c.rpc("record_caterlink_part_b_secure", o.sig !== undefined ? rpcArgs(tx, o, o.sig) : rpcArgs(tx, o, bound.partB(tx.id)));

console.log("=== authorization, workflow state and validation (REST RPC as the user) ===");
if (argVal("rest") !== "0") {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const before = await snap(TX["pen-pass"]);
  const r = await call(anon, TX["pen-pass"]);
  ok("anonymous: the RPC is not callable", !!r.error && /permission denied|not authori|JWT/i.test(r.error.message), r.error?.code);
  const refusals = new Set();
  const denials = [
    ["caterlink_management", "pen-pass"], ["operation_manager", "pen-pass"], ["hub_se", "pen-pass"], ["aso-kul", "pen-pass"], ["profiling_aso", "pen-pass"],
    ["so", "pen-pass"], ["caterlink-driver", "pen-pass"], ["caterlink-vendor", "pen-pass"], ["aso-jhb", "pen-pass"], ["aso", "jhb-denial"], ["aso-no-caterlink", "pen-pass"],
  ];
  for (const [label, key] of denials) {
    const c = await rest(label);
    const b = await snap(TX[key]);
    const r2 = await call(c, TX[key]);
    const a = await snap(TX[key]);
    refusals.add(r2.error?.message ?? "(accepted)");
    const gate1 = await uploadBound({ sb: c }, bound.partB(TX[key].id));
    if (gate1.outcome === "setup") throw new SetupError(`${label}: the upload probe hit a fixture/setup fault: ${String(gate1.error?.message ?? "").slice(0, 80)}`);
    ok(`${label} on ${key}: the Storage upload gate refuses it too`, gate1.outcome === "authorization", gate1.outcome);
    ok(`${label} on ${key}: refused, nothing written`, !!r2.error && same(a, b), r2.error ? "refused" : "ACCEPTED");
  }
  // the refusal must not depend on whether the movement exists or sits at another station: same caller, same message
  const ghost = { id: "00000000-0000-4000-8000-000000000b01", sealId: "00000000-0000-4000-8000-000000000b02" };
  for (const [label, key] of [["aso", "jhb-denial"], ["aso-kul", "pen-pass"], ["caterlink_management", "pen-pass"]]) {
    const real = await call(await rest(label), TX[key]);
    const none = await call(await rest(label), ghost);
    ok(`${label}: the refusal for a real other-station movement equals the refusal for a movement that does not exist (no existence leak)`, !!real.error && real.error.message === none.error?.message, real.error?.message?.slice(0, 60));
  }
  ok("refusals are generic (no table, function, user or station detail)", [...refusals].every((m) => m.length < 90 && !/public\.|supabase|policy|violates|uuid|row-level/i.test(m)), [...refusals].join(" | "));
  ok("anonymous attempt changed nothing", same(await snap(TX["pen-pass"]), before));

  const aso = await rest("aso");
  const ws = await snap(TX["pen-wrong-state"]);
  const rw = await call(aso, TX["pen-wrong-state"]);
  ok("workflow: Part B on a movement already past Part B is refused, nothing written", !!rw.error && same(await snap(TX["pen-wrong-state"]), ws), rw.error?.message?.slice(0, 80));
  const pre = await snap(TX["pen-pass"]);
  const bad = [
    ["missing observed vehicle", { vehicle: "" }], ["missing observed driver", { dname: "", did: "" }], ["invalid result", { result: "MAYBE" }],
    ["ESCALATE without a reason", { result: "ESCALATE", reason: "" }], ["unchecked vehicle on PASS", { veh: false }], ["bad signature path", { sig: "../x" }],
  ];
  for (const [what, o] of bad) { const r3 = await call(aso, TX["pen-pass"], o); ok(`validation: ${what} is rejected`, !!r3.error); }
  ok("validation failures wrote nothing", same(await snap(TX["pen-pass"]), pre));
}

console.log("=== concurrency (8 simultaneous real requests, one officer, one movement) ===");
if (argVal("rest") !== "0") {
  const aso = await rest("aso");
  const tx = TX["pen-concurrent"];
  const fresh = (await snap(tx)).status === "CREATED";
  const res = await Promise.all(Array.from({ length: 8 }, () => callUploaded(aso, tx)));
  const rows = res.map((r) => r.data?.[0]).filter(Boolean);
  const s = await snap(tx);
  ok("exactly one request recorded the checkpoint (is_new)", fresh ? rows.filter((r) => r.is_new).length === 1 : rows.filter((r) => r.is_new).length === 0 && s.partB === 1, `${fresh ? "" : "(already exercised in an earlier pass) "}new=${rows.filter((r) => r.is_new).length} replies=${rows.length} errors=${res.filter((r) => r.error).length}`);
  ok("the others returned the idempotent ALREADY_RECORDED outcome", rows.filter((r) => !r.is_new).every((r) => r.outcome === "ALREADY_RECORDED"));
  ok("one part_b_c row, one audit entry, one seal verification, one transition", s.partB === 1 && s.audit === 1 && s.verifs === 1 && s.status === "INFLIGHT_POST_APPROVED", JSON.stringify(s));
  const nx = nextStepFor("OUTBOUND", "INFLIGHT_POST_APPROVED", "AIRCRAFT");
  ok("downstream: the next checkpoint after Part B is Part C", nx?.slug === "part-c", nx?.slug);
  const pdf = (await q("select (select count(*)::int from public.caterlink_pdf_jobs where transaction_id = $1) + (select count(*)::int from public.caterlink_transaction_pdfs where transaction_id = $1) n", [tx.id]))[0].n;
  ok("PDF/version: an outbound Part B creates no PDF job or version (the final PDF is a post-receipt record)", pdf === 0, `rows=${pdf}`);
  const row = (await q("select avsec_name, completed_by, seal_verified, result, checkpoint_date is not null d, checkpoint_time is not null t from public.part_b_c where transaction_id = $1", [tx.id]))[0];
  const actor = manifest.find((a) => a.label === "aso").authUserId;
  ok("the recorded actor is the authenticated officer and the server stamped date and time", row.completed_by === actor && row.d && row.t && row.seal_verified === true && row.result === "PASS");
  const immut = await q("select 1 from pg_trigger where tgname = 'trg_part_b_c_immutable' and tgenabled = 'O'");
  ok("the completed record is protected by the immutability trigger", immut.length === 1);
  const upd = await client.query("begin").then(() => client.query("update public.part_b_c set remarks = 'x' where transaction_id = $1", [tx.id])).then(() => "updated").catch(() => "refused");
  await client.query("rollback");
  ok("a completed Part B record cannot be rewritten", upd === "refused");
}

// this run's own unreferenced signature leftovers (the 7 losers of the concurrency burst, uploads before a refused call) are removed so the next run keeps its hourly quota
if (argVal("rest") !== "0") await cleanupOwnOrphans(resolveStagingAdminContext().client);
if (argVal("rest") !== "0" && argVal("browser") !== "0") { console.log("(pausing 5 minutes so the REST sign-ins do not rate-limit the browser sign-ins)"); await sleep(300000); }
if (argVal("browser") === "0") { await client.end(); console.log(fails ? `\nREST PATH: ${fails} FAILED` : "\nREST PATH PASSED"); process.exit(fails ? 1 : 0); }

// ------------------------------------------------------------------ browser path
console.log("\n=== browser path ===");
const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function signIn(label, viewport = { width: 1366, height: 850 }, attempt = 1) {
  const a = creds.find((x) => x.label === label);
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 60000 });
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 45000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await sleep(6000);
  // Auth rate limiting presents as a stalled sign-in: wait and retry once, never report a stalled sign-in as a result
  if (/\/login$/.test(new URL(page.url()).pathname) && attempt < 3) { await ctx.close(); await sleep(60000); return signIn(label, viewport, attempt + 1); }
  return { ctx, page };
}
async function scan(page, ref) {
  await page.goto(`${base}/avsec/scan`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#unified-scan-manual", { timeout: 30000 });
  await page.waitForFunction(() => { const el = document.querySelector("#unified-scan-manual"); return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 30000 });
  await page.fill("#unified-scan-manual", ref);
  await page.getByRole("button", { name: "Find" }).click();
  return page.waitForURL(/\/icms\/transactions\//, { timeout: 40000 }).then(() => true).catch(() => false);
}
async function sign(page) {
  const canvas = page.locator("canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 90, { steps: 6 });
  await page.mouse.move(box.x + 140, box.y + 50, { steps: 6 });
  await page.mouse.up();
}
async function fillForm(page, { seal = P.sealNumber, vehicle = P.vehicleNumber } = {}) {
  await page.locator("#observed_vehicle_number").fill(vehicle);
  await page.locator("#observed_driver_name").fill(P.driverName);
  await page.locator("#observed_driver_id").fill(P.driverStaffId);
  await page.locator("#vehicle_verified").check();
  await page.locator("#driver_verified").check();
  await page.getByLabel("Seal 1 number as read").fill(seal);
  await page.getByRole("button", { name: "Blue", exact: true }).click();
  await sign(page);
}
const sealCount = async (tx) => (await q("select count(*)::int n from public.seals where transaction_id = $1", [tx.id]))[0].n;
const txUrl = (tx, tail = "") => `${base}/icms/transactions/${tx.id}${tail}`;

async function officerFlow(label, key, station) {
  const tx = TX[key];
  const { ctx, page } = await signIn(label);
  ok(`${label}: signs in and is not held at the duty gate`, !/\/(login|avsec\/duty)$/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
  const nav = await scan(page, tx.number);
  ok(`${label}: scanning the ${station} reference opens Part B`, nav && /\/part-b$/.test(new URL(page.url()).pathname));
  const heading = (await page.locator("h1").first().textContent({ timeout: 15000 }).catch(() => ""))?.trim();
  ok(`${label}: Part B is a functional page (not the "not activated" placeholder)`, /Part B/.test(heading ?? "") && !/not activated/i.test((await page.textContent("body")) ?? ""), heading?.slice(0, 60));
  const body = (await page.textContent("body")) ?? "";
  ok(`${label}: required data is displayed (vehicle, driver, driver ID, seal number)`, body.includes(P.vehicleNumber) && body.includes(P.driverStaffId) && (await page.locator('[aria-label="Seal 1 number as read"]').count()) === 1);
  const submitBtn = page.locator('form:has(#observed_vehicle_number) button[type="submit"]');
  ok(`${label}: the submit button is disabled until the form is complete`, await submitBtn.isDisabled());
  const b = await snap(tx);
  await fillForm(page);
  ok(`${label}: the submit button enables with a valid form`, await submitBtn.isEnabled());
  await submitBtn.click();
  await page.waitForURL((u) => /approved=1/.test(u.search), { timeout: 60000 }).catch(() => {});
  const a = await snap(tx);
  ok(`${label}: authorized submission succeeds (INFLIGHT_POST_APPROVED, one record, one audit entry)`, a.status === "INFLIGHT_POST_APPROVED" && a.partB === 1 && a.audit === 1 && a.verifs === 1 && b.partB === 0, JSON.stringify(a));
  await page.goto(txUrl(tx, "/part-b"), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  ok(`${label}: revisiting Part B no longer offers the form (order enforced)`, (await page.locator("#observed_vehicle_number").count()) === 0);
  const rep = await call(await rest(label), tx);
  ok(`${label}: repeated submission is idempotent (ALREADY_RECORDED, no second record/audit/transition)`, rep.data?.[0]?.outcome === "ALREADY_RECORDED" && same(await snap(tx), a), rep.data?.[0]?.outcome);
  await ctx.close();
}

await officerFlow("aso", "pen-pass", "PEN");
await sleep(8000);
await officerFlow("aso-jhb", "jhb-pass", "JHB");
await sleep(8000);

// escalation path: a wrong seal number on PASS must freeze the movement, raise an incident and notify management
{
  const tx = TX["pen-escalate"];
  const { ctx, page } = await signIn("aso");
  if ((await snap(tx)).status === "CREATED") {
    await scan(page, tx.number);
    await fillForm(page, { seal: "WRONG-SEAL-0000" });
    ok("aso: the form flags the seal as not matching before submit", /Does not match/i.test((await page.textContent("body")) ?? ""));
    await page.locator('form:has(#observed_vehicle_number) button[type="submit"]').click();
    // an automatic escalation redirects to the transaction page, which shows the hold instruction as an alert
    await page.waitForURL((u) => /hold=SEAL_MISMATCH/.test(u.search), { timeout: 60000 }).catch(() => {});
    ok("aso: the officer is redirected to the transaction with the SEAL MISMATCH hold instruction", /escalated=1&hold=SEAL_MISMATCH/.test(new URL(page.url()).search));
    ok("aso: the instruction 'Do not release the vehicle' is shown as an alert", (await page.locator('[role="alert"]').filter({ hasText: /SEAL MISMATCH[\s\S]*Do not release the vehicle/i }).count()) > 0);
    for (let i = 0; i < 30 && (await snap(tx)).status === "CREATED"; i += 1) await sleep(1000);
  } else console.log("  (the seal-mismatch submission was already exercised in an earlier pass; verifying its recorded state)");
  const s = await snap(tx);
  ok("seal mismatch: transaction ESCALATED, an incident raised, no PASS record", s.status === "ESCALATED" && s.incidents === 1 && s.partB === 0, JSON.stringify(s));
  const inc = (await q("select incident_type from public.caterlink_incidents where transaction_id = $1", [tx.id]))[0]?.incident_type;
  ok("the incident type is SEAL_MISMATCH", inc === "SEAL_MISMATCH", inc);
  const nots = await q("select rd.code as role, count(distinct u.id)::int n from public.user_notifications u join public.user_role_assignments ura on ura.profile_id = u.recipient_profile_id and ura.revoked_at is null join public.role_definitions rd on rd.id = ura.role_definition_id where u.dedup_key like $1 and u.event_type = 'caterlink_checkpoint_escalated' group by rd.code", [`cp_esc:${tx.id}:%`]);
  ok("notifications were created through the canonical notification table, for CaterLink Management / Operation Manager only", nots.length > 0 && nots.every((r) => ["caterlink_management", "operation_manager"].includes(r.role)), nots.map((r) => `${r.role}=${r.n}`).join(","));
  const incId = (await q("select id from public.caterlink_incidents where transaction_id = $1", [tx.id]))[0]?.id;
  const aud = (await q("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_checkpoint_escalate' and actor_id = $2", [incId, manifest.find((a) => a.label === "aso").authUserId]))[0].n;
  ok("the escalation is audited against the incident with the officer as the actor", aud === 1, `entries=${aud}`);
  const hidden = (await q("select count(*)::int n from public.caterlink_incidents where transaction_id = $1 and incident_type = 'SEAL_MISMATCH' and status = 'OPEN'", [tx.id]))[0].n;
  ok("exactly one open SEAL_MISMATCH incident exists for the movement", hidden === 1, `incidents=${hidden}`);
  await page.goto(txUrl(tx, "/part-b"), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  ok("an escalated movement refuses further checkpoints (no form)", (await page.locator("#observed_vehicle_number").count()) === 0);
  await ctx.close();
}
await sleep(8000);

// roles that must not reach a working Part B form
for (const [label, expectNote] of [["so", "on-duty gate (no duty today)"], ["aso-kul", "other station"], ["caterlink_management", "management"], ["operation_manager", "operation manager"], ["profiling_aso", "profiling"], ["caterlink-driver", "CaterLink driver"], ["caterlink-vendor", "CaterLink vendor"]]) {
  const { ctx, page } = await signIn(label);
  ok(`${label}: signed in (the denial below is authorization, not a stalled sign-in)`, !/\/login$/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
  const target = label === "so" ? TX["pen-layout"] : TX["jhb-denial"];
  await page.goto(txUrl(target, "/part-b"), { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const p = new URL(page.url()).pathname;
  const hasForm = (await page.locator("#observed_vehicle_number").count()) > 0;
  ok(`${label} (${expectNote}): no working Part B form on the movement`, !hasForm, p.replace(/[0-9a-f-]{36}/, ":id"));
  if (label === "so") ok("so: an officer at the right station with NO duty today is redirected (not-on-duty) before the page loads", p === "/icms/dashboard" && /error=not-on-duty/.test(new URL(page.url()).search), p + new URL(page.url()).search);
  if (label === "caterlink-driver" || label === "caterlink-vendor") ok(`${label}: stays inside CaterLink (no VECTA workspace)`, !/^\/avsec\//.test(p) && !/^\/(super-admin|icms\/admin)/.test(p), p.replace(/[0-9a-f-]{36}/, ":id"));
  await ctx.close();
  await sleep(6000);
}
ok("none of the denial attempts changed the jhb-denial or pen-layout movements", same(await snap(TX["jhb-denial"]), { status: "CREATED", partB: 0, incidents: 0, audit: 0, verifs: 0 }) && same(await snap(TX["pen-layout"]), { status: "CREATED", partB: 0, incidents: 0, audit: 0, verifs: 0 }));

// responsive layout and keyboard/accessibility on the real form (a fresh, unsubmitted PEN movement)
{
  for (const [name, vp] of [["mobile", { width: 375, height: 812 }], ["tablet", { width: 768, height: 1024 }], ["desktop", { width: 1366, height: 850 }]]) {
    const { ctx, page } = await signIn("aso", vp);
    await page.goto(txUrl(TX["pen-layout"], "/part-b"), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const view = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    ok(`${name} (${vp.width}px): no horizontal overflow on the Part B page`, view.sw <= view.iw + 1, `${view.sw}/${view.iw}`);
    const sig = await page.locator("canvas").first().boundingBox();
    ok(`${name}: the signature area fits the viewport`, !!sig && sig.x >= 0 && sig.x + sig.width <= vp.width + 1, sig ? `${Math.round(sig.width)}px` : "none");
    if (name === "desktop") {
      await page.locator("#observed_vehicle_number").focus();
      const seen = [];
      for (let i = 0; i < 40; i += 1) { await page.keyboard.press("Tab"); seen.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName)); }
      const need = ["observed_driver_name", "observed_driver_id", "vehicle_verified", "driver_verified", "Seal 1 number as read"];
      ok("keyboard: every field is reachable with Tab in a sensible order", need.every((id) => seen.includes(id)) && seen.indexOf("observed_driver_name") < seen.indexOf("vehicle_verified"), seen.slice(0, 10).join(">"));
      const unlabeled = await page.evaluate(() => [...document.querySelectorAll("form input:not([type=hidden]), form textarea")].filter((el) => !el.labels?.length && !el.getAttribute("aria-label")).length);
      ok("accessibility: every visible form control has an accessible name", unlabeled === 0, `unlabeled=${unlabeled}`);
    }
    await ctx.close();
    await sleep(6000);
  }
}
await browser.close();
await client.end();
console.log(fails ? `\nPART B PROBE: ${fails} FAILED` : "\nPART B PROBE PASSED");
process.exit(fails ? 1 : 0);
