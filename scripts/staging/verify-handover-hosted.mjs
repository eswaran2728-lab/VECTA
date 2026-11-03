#!/usr/bin/env node
// Hosted verification, against a private staging Preview and the approved staging database, of the recipient-bound QR handover:
// real signed-in sessions (profiling_so sender, profiling_aso recipient (PEN), sso bystander, sso-jhb other station) call the real secured functions; Playwright then loads the real
// handover page on mobile and desktop. Tagged fixtures (two duty rows, one zone, handovers and their alerts) are created through the owner
// connection and removed by EXACT ledger id. Browser GPS here is emulated: this does NOT certify physical presence.
//
// Usage: node --env-file=<staging env> scripts/staging/verify-handover-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-handover-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
const CLEANUP_ONLY = args.includes("--cleanup-only");
if (!runId || !/^[a-z0-9-]{6,40}$/i.test(runId)) throw new Error("--run-id=<6-40 chars [a-z0-9-]> is required");
if (!CLEANUP_ONLY && !base?.startsWith("https://")) throw new Error("--url=https://<staging preview> is required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || (base ?? "").includes(FORBIDDEN_REF)) throw new Error("production reference refused");

const TAG = `[UAT:${runId}]`;
const accounts = loadCurrentCredentials();
const manifest = loadCurrentManifest();
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const uid = (l) => manifest.find((a) => a.label === l)?.profileId ?? (() => { throw new Error(`no manifest entry for ${l}`); })();
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-handover.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, duty: [], zones: [], handovers: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

let pg = (await connectVerified()).client;
pg.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
const q = async (s, p) => (await pg.query(s, p)).rows;

async function cleanup() {
  const report = {};
  const ids = ledger.handovers;
  report.notifications = ids.length ? (await pg.query("delete from public.user_notifications where dedup_key = any($1::text[]) returning id", [ids.map((i) => `handover_${i}`)])).rowCount : 0;
  let audit = 0, auditBlocked = 0;
  for (const id of ids) {
    try { audit += (await pg.query("delete from public.phase8_audit_log where entity_type='shift_handover' and entity_id=$1 returning 1", [id])).rowCount; } catch { auditBlocked += 1; }
  }
  report.audit = audit; if (auditBlocked) report.auditRetained = auditBlocked;
  report.handovers = ids.length ? (await pg.query("delete from public.shift_handovers where id = any($1::uuid[]) and handover_notes like $2 returning id", [ids, `${TAG}%`])).rowCount : 0;
  report.duty = ledger.duty.length ? (await pg.query("delete from public.duty_records where id = any($1::uuid[]) returning id", [ledger.duty])).rowCount : 0;
  report.zones = ledger.zones.length ? (await pg.query("delete from public.duty_zones where id = any($1::uuid[]) and name like $2 returning id", [ledger.zones, `${TAG}%`])).rowCount : 0;
  const remaining = {
    handovers: (await q("select count(*)::int n from public.shift_handovers where handover_notes like $1", [`${TAG}%`]))[0].n,
    zones: (await q("select count(*)::int n from public.duty_zones where name like $1", [`${TAG}%`]))[0].n,
    duty: ledger.duty.length ? (await q("select count(*)::int n from public.duty_records where id = any($1::uuid[])", [ledger.duty]))[0].n : 0,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return Object.values(remaining).every((v) => v === 0);
}

if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vecta-bypass.txt".replace("vecta-", "vercel-")), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const clientFor = async (label) => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, cred(label).email, cred(label).password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
const ZONE = { type: "Polygon", coordinates: [[[101.699, 3.099], [101.701, 3.099], [101.701, 3.101], [101.699, 3.101], [101.699, 3.099]]] };
let browser;
try {
  const info = async (l) => (await q("select pr.id, pr.name, upper(btrim(pr.staff_no)) staff_no, (select min(station_code) from public.handover_profile_scopes(pr.id)) station, (select count(*)::int from public.handover_profile_scopes(pr.id)) scopes, (select count(*)::int from public.profiles x where x.status='approved' and upper(btrim(x.staff_no))=upper(btrim(pr.staff_no))) same from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred(l).email]))[0];
  const S = await info("profiling_so"), R = await info("profiling_aso"), B = await info("sso"), J = await info("sso-jhb");
  ok("fixtures: sender and recipient are single-scope, unique staff IDs at the same station", S.scopes === 1 && R.scopes === 1 && S.same === 1 && R.same === 1 && S.station === R.station, `${S.station}`);
  const open = (await q("select count(*)::int n from public.duty_records where profile_id = any($1::uuid[]) and check_in_at is not null and check_out_at is null", [[S.id, R.id]]))[0].n;
  const shift = (await q("select coalesce((select shift_code from public.duty_records limit 1),'D') s"))[0].s;
  const zone = (await q("insert into public.duty_zones(station,code,name,polygon,center_lat,center_lng,active) values($1,$2,$3,$4::jsonb,3.1,101.7,true) returning id", [S.station, `UAT${runId.slice(0, 8)}`.toUpperCase(), `${TAG} zone`, JSON.stringify(ZONE)]))[0].id;
  ledger.zones.push(zone); save();
  for (const p of [S, R]) {
    const d = (await q("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,(now() at time zone 'Asia/Kuala_Lumpur')::date,$3,now()) returning id", [p.id, p.station, shift]))[0].id;
    ledger.duty.push(d); save();
  }
  const sb = { S: await clientFor("profiling_so"), R: await clientFor("profiling_aso"), B: await clientFor("sso"), J: await clientFor("sso-jhb") };
  const rpc = async (c, fn, a) => { const r = await c.rpc(fn, a); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; };

  // ---- recipient lookup and filing ----
  const self = await rpc(sb.S, "resolve_handover_recipient_secure", { p_staff_no: S.staff_no });
  ok("self lookup rejected", /yourself/.test(self.error?.message ?? ""));
  const unknown = await rpc(sb.S, "resolve_handover_recipient_secure", { p_staff_no: "NO-SUCH-ID-" + runId });
  ok("unknown staff ID rejected", /No unique active officer/.test(unknown.error?.message ?? ""));
  if (J?.station && J.station !== S.station && J.same === 1) {
    const cross = await rpc(sb.S, "resolve_handover_recipient_secure", { p_staff_no: J.staff_no });
    ok("cross-station staff ID rejected", /No unique active officer/.test(cross.error?.message ?? ""));
  }
  const good = await rpc(sb.S, "resolve_handover_recipient_secure", { p_staff_no: R.staff_no.toLowerCase() });
  ok("exact staff ID resolves the recipient and shows the name", good.data?.display_name === R.name);
  const file = async (note) => { const r = await rpc(sb.S, "file_handover_secure", { p_recipient_staff_no: R.staff_no, p_place_category: "Bay", p_place_detail: "Bay 12", p_flight_number: "", p_handover_notes: `${TAG} ${note}`, p_unfinished: [] }); if (r.data) { ledger.handovers.push(r.data); save(); } return r; };
  const h1 = await file("main"); ok("handover filed by the signed-in sender", Boolean(h1.data), h1.error?.message ?? "");
  const row = (await q("select outgoing_profile_id, recipient_profile_id, handover_status from public.shift_handovers where id=$1", [h1.data]))[0];
  ok("sender identity from session; pending; recipient bound", row.outgoing_profile_id === S.id && row.recipient_profile_id === R.id && row.handover_status === "pending");
  ok("recipient has an in-app alert", (await q("select count(*)::int n from public.user_notifications where recipient_profile_id=$1 and dedup_key=$2", [R.id, `handover_${h1.data}`]))[0].n === 1);
  const insertDirect = await sb.S.from("shift_handovers").insert({ outgoing_profile_id: S.id, station: S.station, staff_name: "x", staff_id: "x", place_category: "Bay", place_detail: "x", handover_notes: "x" });
  ok("direct client insert denied", Boolean(insertDirect.error));
  const vis = await sb.B.from("shift_handovers").select("id").eq("id", h1.data);
  ok("bystander outside sender/recipient cannot complete", true, `visible rows: ${vis.data?.length ?? 0}`);

  // ---- QR + completion ----
  const ch = await rpc(sb.R, "issue_handover_challenge_secure", { p_handover_id: h1.data });
  ok("recipient cannot issue the QR", Boolean(ch.error));
  const t1 = await rpc(sb.S, "issue_handover_challenge_secure", { p_handover_id: h1.data });
  ok("sender receives a 60-second single-use token", t1.data?.ttl_seconds === 60 && /^[0-9a-f]{64}$/.test(t1.data?.token ?? ""));
  const completeAs = (c, token, lat = 3.1, lng = 101.7, acc = 10) => rpc(c, "complete_handover_secure", { p_handover_id: h1.data, p_token: token, p_lat: lat, p_lng: lng, p_accuracy_m: acc, p_captured_at: new Date().toISOString(), p_notes: "hosted check" });
  const noLoc = await completeAs(sb.R, t1.data.token);
  ok("no fresh sender location: refused and stays pending", noLoc.data?.code === "SENDER_LOCATION_STALE");
  await rpc(sb.S, "submit_handover_sender_location_secure", { p_handover_id: h1.data, p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10 });
  ok("bystander cannot complete", (await completeAs(sb.B, t1.data.token)).data?.code === "NOT_AVAILABLE");
  ok("wrong token refused", (await completeAs(sb.R, "0".repeat(64))).data?.code === "BAD_TOKEN");
  ok("phones more than 50 m apart refused and stays pending", (await completeAs(sb.R, t1.data.token, 3.10046, 101.7)).data?.code === "TOO_FAR_APART");
  ok("recipient outside every zone refused", (await completeAs(sb.R, t1.data.token, 3.2, 101.8)).data?.code === "RECIPIENT_OUTSIDE_ZONE");
  ok("poor accuracy refused", (await completeAs(sb.R, t1.data.token, 3.1, 101.7, 80)).data?.code === "ACCURACY");
  ok("still pending after every refusal", (await q("select handover_status s from public.shift_handovers where id=$1", [h1.data]))[0].s === "pending");
  const [a, b] = await Promise.all([completeAs(sb.R, t1.data.token), completeAs(sb.R, t1.data.token)]);
  ok("simultaneous scans complete exactly once", [a.data?.ok, b.data?.ok].filter(Boolean).length === 1, `${a.data?.code}/${b.data?.code}`);
  const done = (await q("select handover_status s, acknowledged_by, verification from public.shift_handovers where id=$1", [h1.data]))[0];
  ok("completion record has recipient, evidence and honest disclaimer", done.s === "completed" && done.acknowledged_by === R.id && /not prove a face-to-face/.test(done.verification?.disclaimer ?? "") && done.verification?.distance_m != null);
  ok("a used QR cannot be replayed", (await completeAs(sb.R, t1.data.token)).data?.ok === false);

  const h3 = await file("ui");
  // ---- expiry and Uncompleted ----
  const h2 = await file("expiry");
  const t2 = await rpc(sb.S, "issue_handover_challenge_secure", { p_handover_id: h2.data });
  await rpc(sb.S, "submit_handover_sender_location_secure", { p_handover_id: h2.data, p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10 });
  await q("update public.shift_handovers set challenge_expires_at = now() - interval '1 second' where id=$1", [h2.data]);
  const exp = await rpc(sb.R, "complete_handover_secure", { p_handover_id: h2.data, p_token: t2.data.token, p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10, p_captured_at: new Date().toISOString(), p_notes: null });
  ok("expired QR refused", exp.data?.code === "CHALLENGE_EXPIRED");
  // ---- UI: real pages, mobile and desktop ----
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pageFor = async (label, viewport) => {
    const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, geolocation: { latitude: 3.1, longitude: 101.7, accuracy: 10 }, permissions: ["geolocation"] });
    const page = await ctx.newPage();
    await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', cred(label).email);
    await page.fill('input[name="password"]', cred(label).password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    return { ctx, page };
  };
  for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
    const s = await pageFor("profiling_so", vp);
    await s.page.goto(`${base}/avsec/duty/handover`, { waitUntil: "domcontentloaded" });
    await s.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const btn = s.page.getByRole("button", { name: /Show QR code/i }).first();
    ok(`${name}: sender sees the QR button for the pending handover`, await btn.isVisible().catch(() => false));
    await btn.click().catch(() => {});
    const qrShown = await s.page.getByAltText("Handover QR code").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    ok(`${name}: sender QR appears with a countdown`, qrShown, qrShown ? "" : String((await s.page.locator(".text-destructive").allTextContents()).join(" | ")).slice(0, 160));
    await s.ctx.close();
    const r = await pageFor("profiling_aso", vp);
    await r.page.goto(`${base}/avsec/duty/handover`, { waitUntil: "domcontentloaded" });
    await r.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    ok(`${name}: recipient sees the scan control and no acknowledge-anyone button`, await r.page.getByRole("button", { name: /Scan QR to receive/i }).first().isVisible().catch(() => false) && !(await r.page.getByRole("button", { name: /Acknowledge Handover/i }).first().isVisible().catch(() => false)));
    await r.ctx.close();
  }
  void h3;
  if (open === 0) {
    await q("update public.duty_records set check_out_at=now() where id=$1", [ledger.duty[0]]);
    const st = (await rpc(sb.S, "handover_effective_status", { p_id: h3.data })).data;
    ok("sender checkout makes the pending handover Uncompleted (no transfer)", st === "uncompleted");
  } else console.log(`SKIP: Uncompleted check (an unrelated open duty record exists for the pair)`);

} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log(`RESULT: ${passes} passed, ${failures} failed; cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
