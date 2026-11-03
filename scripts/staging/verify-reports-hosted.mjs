#!/usr/bin/env node
// Hosted verification, against the approved staging database with REAL signed-in sessions, of the server side of the SEC014 whole-form draft (store, resume from a
// second device, isolation from other users, replace on re-save, clear) and of the DSE-alert delivery health surface. NOT exercised hosted: the SEC014 page itself
// and an end-to-end submission, because staging has no ASO login (the only role assigned SEC014) and no DSE of the same entity as a usable officer. Those paths are
// covered by unit tests and by the guarded dry run (a real submitted SEC014 fires the trigger; 12 probes). Everything created is removed by EXACT id.
//
// Usage: node --env-file=<staging env> scripts/staging/verify-reports-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-reports-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

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
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-reports.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, profile: null, reports: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

let pg = (await connectVerified()).client;
pg.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
const q = async (s, p) => (await pg.query(s, p)).rows;

async function cleanup() {
  const report = {};
  const ids = ledger.reports;
  report.notifications = ids.length ? (await pg.query("delete from public.user_notifications where dedup_key like any($1::text[]) returning id", [ids.map((i) => `dse_report:report_sec014:${i}:%`)])).rowCount : 0;
  report.failures = ids.length ? (await pg.query("delete from public.report_notification_failures where source_id = any($1::uuid[]) returning id", [ids])).rowCount : 0;
  if (ledger.profile) report.drafts = (await pg.query("delete from public.report_drafts where profile_id=$1 and report_type='sec014' returning id", [ledger.profile])).rowCount;
  if (ids.length) {
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    for (const [t, c] of [["sheet_sync_queue", "source_id"], ["report_versions", "report_id"], ["report_sec014_patrols", "report_id"]]) {
      try { report[t] = (await pg.query(`delete from public.${t} where ${c} = any($1::uuid[]) returning 1`, [ids])).rowCount; } catch { /* table or column differs: reported below if rows remain */ }
    }
    report.reports = (await pg.query("delete from public.report_sec014 where id = any($1::uuid[]) and remark like $2 returning id", [ids, `${TAG}%`])).rowCount;
    await pg.query("commit");
  }
  const remaining = {
    reports: (await q("select count(*)::int n from public.report_sec014 where remark like $1", [`${TAG}%`]))[0].n,
    drafts: ledger.profile ? (await q("select count(*)::int n from public.report_drafts where profile_id=$1 and report_type='sec014'", [ledger.profile]))[0].n : 0,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return remaining.reports === 0 && remaining.drafts === 0;
}
if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

import { createClient } from "@supabase/supabase-js";
import { signInWithRetry } from "./lib/review-accounts.mjs";
const clientFor = async (label) => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, cred(label).email, cred(label).password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
try {
  const me = (await q("select pr.id from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred("sso-kul").email]))[0];
  ledger.profile = me.id; save();
  ok("fixture: no SEC014 server draft exists for the synthetic officer", (await q("select count(*)::int n from public.report_drafts where profile_id=$1 and report_type='sec014'", [me.id]))[0].n === 0);
  const phone = await clientFor("sso-kul"), laptop = await clientFor("sso-kul"), other = await clientFor("profiling_so");
  const form = { remark: `${TAG} whole form`, date_in: "2026-11-03", time_in: "08:00", date_out: "2026-11-03", time_out: "16:00", patrols: [{ location: "Bay 1", time_from: "09:00", time_to: "10:00", description: "walk" }], acknowledgement: false };
  const t1 = new Date().toISOString();
  const up = await phone.from("report_drafts").upsert({ profile_id: me.id, report_type: "sec014", data: form, updated_at: t1 }, { onConflict: "profile_id,report_type" });
  ok("Save draft stores the whole form on the server", !up.error, up.error?.message ?? "");
  const got = await laptop.from("report_drafts").select("data, updated_at").eq("profile_id", me.id).eq("report_type", "sec014").maybeSingle();
  ok("a second device resumes the same whole form with its save time", got.data?.data?.remark === form.remark && got.data?.data?.patrols?.[0]?.location === "Bay 1" && got.data?.data?.time_out === "16:00" && Math.abs(Date.parse(got.data?.updated_at) - Date.parse(t1)) < 30000);
  const stolen = await other.from("report_drafts").select("data").eq("profile_id", me.id).eq("report_type", "sec014");
  ok("another user cannot read the draft", (stolen.data?.length ?? 0) === 0);
  const hijack = await other.from("report_drafts").upsert({ profile_id: me.id, report_type: "sec014", data: { remark: "x" } }, { onConflict: "profile_id,report_type" });
  ok("another user cannot overwrite the draft", Boolean(hijack.error) || (await q("select data->>'remark' r from public.report_drafts where profile_id=$1 and report_type='sec014'", [me.id]))[0].r === form.remark);
  const t2 = new Date(Date.now() + 1000).toISOString();
  await laptop.from("report_drafts").upsert({ profile_id: me.id, report_type: "sec014", data: { ...form, remark: `${TAG} edited on laptop` }, updated_at: t2 }, { onConflict: "profile_id,report_type" });
  const again = await phone.from("report_drafts").select("data, updated_at").eq("profile_id", me.id).eq("report_type", "sec014").maybeSingle();
  ok("re-saving replaces the one draft and moves its time forward", again.data?.data?.remark === `${TAG} edited on laptop` && Date.parse(again.data.updated_at) > Date.parse(t1) && (await q("select count(*)::int n from public.report_drafts where profile_id=$1 and report_type='sec014'", [me.id]))[0].n === 1);
  const del = await phone.from("report_drafts").delete().eq("profile_id", me.id).eq("report_type", "sec014");
  ok("a confirmed submission can clear the server draft", !del.error && (await q("select count(*)::int n from public.report_drafts where profile_id=$1 and report_type='sec014'", [me.id]))[0].n === 0);
  const om = await clientFor("operation_manager");
  const health = await om.from("v_report_notification_health").select("open_failures,total_failures");
  ok("technical monitoring can read the notification health view", !health.error && health.data?.length === 1, health.error?.message ?? JSON.stringify(health.data));
  const officerHealth = await phone.from("report_notification_failures").select("id");
  ok("an ordinary officer cannot read delivery failures", (officerHealth.data?.length ?? 0) === 0);
} finally {
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log(`RESULT: ${passes} passed, ${failures} failed; cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
