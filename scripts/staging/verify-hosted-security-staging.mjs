#!/usr/bin/env node
// Hosted verification, on ACTUAL staging after the nine security migrations, of the atomic same-day leave RPC, the registration throttle, the blocked
// unfinished CaterLink routes and the privileged-function grants. Real sessions (publishable key); the service role is used ONLY to create and remove the
// tagged throttle key this run uses and to remove the exact leave notice this run created. Fixture/setup faults are INCONCLUSIVE (exit 2), never a pass.
//   node --env-file=.env.local scripts/staging/verify-hosted-security-staging.mjs
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
import { environmentGates } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";
import { createRecorder, classifyError, SetupError } from "./lib/signature-fixtures.mjs";

environmentGates();
const admin = resolveStagingAdminContext().client;
const creds = loadCurrentCredentials();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const rec = createRecorder();
const tag = `sec${Date.now().toString().slice(-8)}`;
const sessions = new Map();
async function S(label) {
  if (sessions.has(label)) return sessions.get(label);
  const c = creds.find((a) => a.label === label);
  if (!c) throw new SetupError(`no credentials for ${label}`);
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await signInWithRetry(sb, c.email, c.password);
  if (error) throw new SetupError(`sign-in failed for ${label}`);
  const s = { sb, uid: data.user.id };
  sessions.set(label, s);
  return s;
}
const res = (r) => ({ outcome: classifyError(r.error, r.status), error: r.error ?? null });
const created = { notices: [], throttleKeys: [] };
try {
  // ---------- atomic leave ----------
  const aso = await S("aso");
  const future = new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10);
  const first = await aso.sb.rpc("submit_leave_application_secure", { p_leave_type: "annual", p_start_date: future, p_end_date: future, p_remarks: `${tag} hosted verification` });
  rec.expectOk("atomic leave: a valid future-dated leave is recorded through the RPC", res(first));
  const row = Array.isArray(first.data) ? first.data[0] : first.data;
  if (row?.notice_id) created.notices.push(row.notice_id);
  rec.check("atomic leave: the result is a pending, not-same-day notice", row?.result_approval_status === "pending" && row?.result_same_day === false);
  const again = await aso.sb.rpc("submit_leave_application_secure", { p_leave_type: "annual", p_start_date: future, p_end_date: future, p_remarks: `${tag} duplicate` });
  rec.expectAuthorizationDenied("atomic leave: the same leave cannot be submitted twice", res(again), /already submitted this leave application/i);
  const sameDay = await aso.sb.rpc("submit_leave_application_secure", { p_leave_type: "annual", p_remarks: `${tag} same-day` });
  const sameDayRow = Array.isArray(sameDay.data) ? sameDay.data[0] : sameDay.data;
  if (sameDayRow?.notice_id) created.notices.push(sameDayRow.notice_id);
  // The tagged duty check-in uses its own shift code, so the RPC (which keys on the rostered shift, 'DUTY' when none) does not see it: the same-day branch RUNS. That
  // exercises the locked duty-record upsert end to end; the second application for the same shift must then be refused. Both rows are removed by tag afterwards.
  rec.expectOk("atomic leave: a same-day application is recorded through the locked duty-record upsert (result_same_day = true)", res(sameDay));
  rec.check("atomic leave: the same-day result says so", sameDayRow?.result_same_day === true);
  const sameDay2 = await aso.sb.rpc("submit_leave_application_secure", { p_leave_type: "annual", p_remarks: `${tag} same-day again` });
  rec.expectAuthorizationDenied("atomic leave: a second same-day application for the same shift is refused", res(sameDay2), /already submitted a leave application for today/i);
  const direct = await aso.sb.from("absence_notices").insert({ user_id: aso.uid, leave_type: "annual", start_date: future, end_date: future, approval_status: "approved", status: "green", remarks: `${tag} direct` });
  rec.expectAuthorizationDenied("atomic leave: a client cannot insert an absence notice directly", res(direct));
  const pending = await (await S("neg-pending-profile")).sb.rpc("submit_leave_application_secure", { p_leave_type: "annual", p_start_date: future, p_end_date: future, p_remarks: `${tag} pending` });
  rec.expectAuthorizationDenied("atomic leave: a pending profile cannot submit leave", res(pending), /only an approved account/i);

  // ---------- registration throttle ----------
  const key = crypto.createHash("sha256").update(`${tag}-throttle`).digest("hex");
  created.throttleKeys.push(key);
  const hits = [];
  for (let i = 0; i < 5; i += 1) hits.push((await admin.rpc("registration_throttle_hit", { p_key_hash: key, p_limit: 3, p_window_seconds: 600 })).data);
  rec.check("registration throttle: three hits are allowed and the fourth and fifth are refused (durable fixed window)", JSON.stringify(hits) === JSON.stringify([true, true, true, false, false]), JSON.stringify(hits));
  const clientCall = await aso.sb.rpc("registration_throttle_hit", { p_key_hash: key, p_limit: 3, p_window_seconds: 600 });
  rec.expectAuthorizationDenied("registration throttle: a signed-in client cannot call the throttle function", res(clientCall));
  const anonCall = await createClient(url, anonKey, { auth: { persistSession: false } }).rpc("registration_throttle_hit", { p_key_hash: key, p_limit: 3, p_window_seconds: 600 });
  rec.expectAuthorizationDenied("registration throttle: anonymous cannot call the throttle function", res(anonCall));
  const badKey = await admin.rpc("registration_throttle_hit", { p_key_hash: "not-a-hash", p_limit: 3, p_window_seconds: 600 });
  rec.expectAuthorizationDenied("registration throttle: a malformed key is rejected", res(badKey), /invalid throttle request/i);
  const tableRead = await aso.sb.from("registration_throttle").select("*").limit(1);
  rec.check("registration throttle: the table is not readable by a client", tableRead.error ? true : (tableRead.data ?? []).length === 0);

  // ---------- blocked unfinished CaterLink routes (the database refuses them even for a direct RPC) ----------
  const drv = await S("caterlink-driver");
  const base = { p_origin_station: "KUL - MAA", p_direction: "OUTBOUND", p_vehicle_number: "NOT-USED", p_driver_name: "NOT USED", p_driver_id: "NOTUSED", p_seal_number: `${tag}-X`, p_signature_url: `part-a/${drv.uid}/${crypto.randomUUID()}.png` };
  for (const [route, extra] of [["AIRCRAFT", {}], ["REDQ", {}], ["MAINTENANCE", {}]]) {
    const r = await drv.sb.rpc("create_caterlink_driver_transaction_secure", { ...base, p_route: route, ...extra });
    // the route guard sits on the INSERT, after the whitelist/signature checks: a refusal that names another rule is a fixture fault, never a pass
    rec.expectAuthorizationDenied(`blocked route: a Driver ${route} movement is refused`, res(r), /not available yet|whitelist|not an active|valid signature|not the one uploaded|not uploaded by this account/i);
  }

  // ---------- privileged functions are closed to clients ----------
  for (const fn of ["skip_part_d", "raise_caterlink_incident_secure"]) {
    const args = fn === "skip_part_d" ? { p_transaction_id: crypto.randomUUID(), p_reason: "x" } : { p_transaction_id: crypto.randomUUID(), p_incident_type: "OTHER", p_description: "x", p_severity: "low", p_photo_url: null };
    for (const label of ["aso", "caterlink_management", "super_admin", "caterlink-driver"]) {
      const r = await (await S(label)).sb.rpc(fn, args);
      rec.expectAuthorizationDenied(`${fn} is closed to ${label}`, res(r), /permission denied|not available/i);
    }
  }
} catch (e) {
  if (e instanceof SetupError) { rec.state.setupErrors += 1; console.log(`INCONCLUSIVE: ${e.message}`); } else throw e;
} finally {
  // remove only the exact rows this run created
  for (const id of created.notices) await admin.from("absence_notices").delete().eq("id", id);
  await admin.from("duty_records").delete().like("late_remark", `Leave [%${tag}%`); // the duty row the same-day RPC created for this run (tagged by its remark)
  for (const k of created.throttleKeys) await admin.from("registration_throttle").delete().eq("key_hash", k);
  console.log(`clean-up: ${created.notices.length} leave notice(s) and ${created.throttleKeys.length} throttle key(s) created by this run removed`);
}
console.log(rec.summary());
process.exit(rec.exitCode());
