#!/usr/bin/env node
// Verification of the two final-receipt accounts (aso-kch-receipt, aso-bki-receipt): read-only database checks plus
// a real publishable-key sign-in for each. Non-destructive: the receipt capability is proven with the decision
// function and with the RPC called for a NON-EXISTENT transaction (an authorized officer gets the post-authorization
// answer, anyone else gets the authorization refusal). No transaction is created or changed.
// Prints labels, booleans and counts only. Usage:
//   node --env-file=.env.local scripts/staging/verify-receipt-accounts.mjs --run-id=<id> --expect-total-auth=54
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, connectVerified, defaultCredentialsDir } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const runId = argVal("run-id");
const expectTotalAuth = parseInt(argVal("expect-total-auth") ?? "54", 10);
let failures = 0;
const check = (label, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return ok; };

async function main() {
  if (!runId) throw new Error("--run-id is required");
  environmentGates();
  const dir = defaultCredentialsDir(runId);
  const creds = loadCurrentCredentials();
  const manifest = loadCurrentManifest().filter((m) => m.run === runId);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  console.log("=== DATABASE VERIFICATION ===");
  const { client: pg } = await connectVerified();
  try {
    await pg.query("BEGIN READ ONLY");
    const n = async (sql, p) => parseInt((await pg.query(sql, p)).rows[0].n, 10);
    check(`Auth users total = ${expectTotalAuth}`, (await n("select count(*)::int n from auth.users")) === expectTotalAuth);
    check(`Profiles total = ${expectTotalAuth}`, (await n("select count(*)::int n from public.profiles")) === expectTotalAuth);
    check("Exactly 2 accounts carry this run", (await n("select count(*)::int n from auth.users where $1::text is not null and raw_user_meta_data->>'vecta_staging_run_id' = $2", [runId, runId])) === 2);
    check("38 dashboard-review accounts in total (36 base + 2 receipt)", (await n("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' like 'dashboard-review-20261005%'")) === 38);
    check("16 original accounts unchanged in count", (await n("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' is null")) === 16);
    check("Dashboard-review assignments total 38", (await n("select count(*)::int n from public.user_role_assignments ura join auth.users u on u.id = ura.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' like 'dashboard-review-20261005%'")) === 38);
    check("Dashboard-review memberships total 26", (await n("select count(*)::int n from public.user_entity_memberships m join auth.users u on u.id = m.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' like 'dashboard-review-20261005%'")) === 26);
    for (const m of manifest) {
      const r = (await pg.query(`
        select p.status::text status, rd.code role, ura.revoked_at, ura.starts_at, ura.ends_at, a.code aoc, d.code dept, h.code hub, s.code station, t.name team, moe.code mentity, mm.status mstatus
        from public.profiles p join public.user_role_assignments ura on ura.profile_id = p.id join public.role_definitions rd on rd.id = ura.role_definition_id
        left join public.aocs a on a.id = ura.aoc_id left join public.departments d on d.id = ura.department_id left join public.hubs h on h.id = ura.hub_id
        left join public.org_stations s on s.id = ura.station_id left join public.org_teams t on t.id = ura.team_id
        left join public.user_entity_memberships mm on mm.id = ura.entity_membership_id left join public.operating_entities moe on moe.id = mm.operating_entity_id
        where p.id = $1`, [m.authUserId])).rows;
      const x = r[0];
      check(`${m.label}: exactly one active assignment aso / MY / operation / ${m.scope.hub} / ${m.scope.station} / ALPHA / MAA membership, approved profile`,
        r.length === 1 && x.status === "approved" && x.role === "aso" && x.aoc === "MY" && x.dept === "operation" && x.hub === m.scope.hub && x.station === m.scope.station && x.team === "ALPHA" && x.mentity === "MAA" && x.mstatus === "active" && x.revoked_at === null && new Date(x.starts_at) <= new Date() && (!x.ends_at || new Date(x.ends_at) > new Date()));
    }
    await pg.query("ROLLBACK");
  } finally { await pg.end(); }

  console.log("\n=== AUTHENTICATED SIGN-IN VERIFICATION (publishable key) ===");
  const STATIONS = ["PEN", "JHB", "KUL - MAA", "KCH", "BKI", "BTU"];
  const MISSING_TX = "00000000-0000-0000-0000-00000000f00d";
  const results = [];
  for (const m of manifest) {
    const cred = creds.find((c) => c.label === m.label);
    const own = m.scope.station;
    const other = own === "KCH" ? "BKI" : "KCH";
    const rec = { label: m.label, checks: {} };
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    try {
      const { data, error } = await signInWithRetry(sb, m.email, cred.password);
      rec.checks.signIn = !error && !!data?.session && data.user.id === m.authUserId;
      const { data: rows } = await sb.rpc("get_my_active_role_assignments");
      rec.checks.assignment = (rows ?? []).length === 1 && rows[0].role_code === "aso" && rows[0].station_code === own && rows[0].team_name === "ALPHA";
      const { data: prof } = await sb.from("profiles").select("status").eq("id", m.authUserId).maybeSingle();
      rec.checks.approved = prof?.status === "approved";
      rec.checks.landing = rec.checks.assignment && rec.checks.approved; // aso -> /avsec/home (same resolver as the 36 accounts)
      const decide = async (st) => (await sb.rpc("can_user_confirm_caterlink_receipt", { p_station_code: st })).data === true;
      const scan = async (st) => (await sb.rpc("can_user_scan_caterlink", { p_station_code: st })).data === true;
      rec.checks.receiptAtOwnStation = (await decide(own)) === true;
      rec.checks.receiptDeniedElsewhere = (await Promise.all(STATIONS.filter((s) => s !== own).map(decide))).every((v) => v === false);
      rec.checks.receiptDeniedAtOtherReceiptStation = (await decide(other)) === false;
      rec.checks.scanDeniedEverywhere = (await Promise.all(STATIONS.map(scan))).every((v) => v === false);
      // RPC proof without touching data: authorized officer passes authorization (post-authorization answer);
      // the same officer at the other station is refused at authorization.
      const ownCall = await sb.rpc("confirm_caterlink_destination_receipt_secure", { p_transaction_id: MISSING_TX, p_station_code: own, p_signature_url: "n/a" });
      const otherCall = await sb.rpc("confirm_caterlink_destination_receipt_secure", { p_transaction_id: MISSING_TX, p_station_code: other, p_signature_url: "n/a" });
      rec.checks.rpcOwnPassesAuthorization = /not available for receipt confirmation/.test(ownCall.error?.message ?? "");
      rec.checks.rpcOtherRefused = /Not authorized to confirm CaterLink receipts/.test(otherCall.error?.message ?? "");
    } catch (e) { rec.error = String(e.message).slice(0, 100); } finally { await sb.auth.signOut().catch(() => {}); }
    const failed = Object.entries(rec.checks).filter(([, v]) => v !== true).map(([k]) => k);
    rec.ok = !rec.error && failed.length === 0;
    if (!rec.ok) failures += 1;
    results.push(rec);
    console.log(`${rec.ok ? "PASS" : "FAIL"}: ${m.label.padEnd(18)} receipt@${own}=allowed scan=denied(all stations) ${failed.length ? "failed=" + failed.join(",") : ""}${rec.error ? " error=" + rec.error : ""}`);
  }
  const reportPath = path.join(dir, `verification-${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ runId, at: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
  console.log(`\nTotal failures: ${failures}\nPrivate verification report: ${reportPath}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
