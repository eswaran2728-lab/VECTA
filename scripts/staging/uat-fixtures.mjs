#!/usr/bin/env node
// Controlled, tagged STAGING-ONLY UAT fixtures: (1) on-duty check-ins for six disposable review accounts, (2) two synthetic MAA / AAX
// flight reports. Default is a DRY RUN. Every created row id is written to a private ledger OUTSIDE the repository and cleanup deletes
// exactly those ids (and only rows still carrying the run tag). No real staff data, no production, no other account, no existing row
// is modified.
//
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=status          --run-id=<id>
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-duty     --run-id=<id> [--live]
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=cleanup-duty    --run-id=<id> [--live]
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-reports  --run-id=<id> [--live]
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=cleanup-reports --run-id=<id> [--live]
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-tx|cleanup-tx --run-id=<id> [--live]   (two synthetic CaterLink movements, origin PEN and JHB, for the scanner / duty-gate probe)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { environmentGates, connectVerified, FORBIDDEN_REF, APPROVED_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const action = argVal("action");
const runId = argVal("run-id");
const LIVE = args.includes("--live");

/** The ONLY accounts these fixtures may touch: label -> expected station code. */
export const DUTY_ACCOUNTS = {
  aso: "PEN", "aso-jhb": "JHB", "aso-kul": "KUL - MAA", "aso-kch-receipt": "KCH", "aso-bki-receipt": "BKI", "aso-no-caterlink": "BTU",
};
const SUBMITTER = "aso-kul";
export const REPORTS = [
  { key: "MAA", flight: "AK9001", reg: "9M-UAT01", flightPrefixEntity: "MAA" },
  { key: "AAX", flight: "D79001", reg: "9M-UAT02", flightPrefixEntity: "AAX" },
];

if (!runId || !/^[a-z0-9-]{6,40}$/i.test(runId)) throw new Error("--run-id=<6-40 chars [a-z0-9-]> is required");
const TAG = `[UAT:${runId}]`;
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}.json`);
const readLedger = () => ({ duty: [], reports: [], tx: [], notifications: [], ...(fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId }) });
const writeLedger = (l) => fs.writeFileSync(ledgerPath, JSON.stringify(l, null, 2), { mode: 0o600 });
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function main() {
  if (!["status", "create-duty", "cleanup-duty", "create-reports", "cleanup-reports", "create-tx", "cleanup-tx", "create-notifications", "cleanup-notifications"].includes(action)) fail("unknown --action");
  environmentGates();
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("production reference present");
  const manifest = loadCurrentManifest();
  const account = (label) => manifest.find((a) => a.label === label) ?? fail(`manifest has no ${label}`);
  const { client } = await connectVerified();
  const q = async (s, p) => (await client.query(s, p)).rows;
  const ledger = readLedger();
  try {
    const host = (await q("select current_setting('server_version') v"))[0].v;
    console.log(`staging ${APPROVED_REF} connected (server ${host}); mode=${LIVE ? "LIVE" : "DRY RUN"}; action=${action}; tag=${TAG}`);
    const today = (await q("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d"))[0].d;

    if (action === "status") {
      console.log(JSON.stringify({ duty: ledger.duty.length, reports: ledger.reports.length, ledger: path.basename(ledgerPath) }));
      return;
    }

    if (action === "create-duty") {
      const plan = [];
      for (const [label, station] of Object.entries(DUTY_ACCOUNTS)) {
        const a = account(label);
        const p = (await q("select id, station, status from public.profiles where id = $1", [a.authUserId]))[0] ?? fail(`${label}: no profile`);
        if (p.status !== "approved" || p.station !== station) fail(`${label}: profile is not approved at ${station}`);
        const existing = (await q("select count(*)::int n from public.duty_records where profile_id = $1 and duty_date = $2::date", [p.id, today]))[0].n;
        if (existing) fail(`${label}: a duty record already exists for ${today}; refusing to collide`);
        plan.push({ label, profileId: p.id, station });
      }
      console.log(`plan: ${plan.map((x) => `${x.label}@${x.station}`).join(", ")} for ${today} (the row expires with the duty date)`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      await client.query("BEGIN");
      try {
        for (const x of plan) {
          const r = (await q(
            `insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, check_in_inside_fence, status, handover_notes)
             values ($1, $2, $3::date, 'UAT', now(), true, 'present', $4) returning id`,
            [x.profileId, x.station, today, TAG],
          ))[0];
          ledger.duty.push({ id: r.id, label: x.label, date: today });
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      writeLedger(ledger);
      console.log(`created ${plan.length} duty rows: ${ledger.duty.map((d) => d.id).join(", ")}`);
      return;
    }

    if (action === "cleanup-duty") {
      const ids = ledger.duty.map((d) => d.id);
      console.log(`ledger duty ids: ${ids.length}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      const del = await q("delete from public.duty_records where id = any($1::uuid[]) and handover_notes = $2 returning id", [ids, TAG]);
      ledger.duty = ledger.duty.filter((d) => !del.some((r) => r.id === d.id));
      writeLedger(ledger);
      console.log(`deleted ${del.length} of ${ids.length}; remaining in ledger ${ledger.duty.length}`);
      return;
    }

    if (action === "create-notifications") {
      const labels = ["maa_admin", "aax_admin", "aso-kul", "aso", "operation_manager", "compliance"];
      console.log(`plan: one synthetic notification for each of ${labels.join(", ")}`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      for (const l of labels) {
        const pid = account(l).authUserId;
        const key = `uat:${runId}:${l}`;
        await q("select public.notify($1, 'request_submitted', $2, null, null, null, $3::jsonb)", [pid, key, JSON.stringify({ uat: runId })]);
        const row = (await q("select id from public.user_notifications where dedup_key = $1", [key]))[0];
        ledger.notifications.push({ id: row.id, label: l, profileId: pid });
      }
      writeLedger(ledger);
      console.log(`created ${ledger.notifications.length} notifications: ${ledger.notifications.map((n) => n.id).join(", ")}`);
      return;
    }

    if (action === "cleanup-notifications") {
      const ids = ledger.notifications.map((n) => n.id);
      console.log(`ledger notification ids: ${ids.length}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      const del = await q("delete from public.user_notifications where id = any($1::uuid[]) and dedup_key like $2 returning id", [ids, `uat:${runId}:%`]);
      ledger.notifications = ledger.notifications.filter((n) => !del.some((r) => r.id === n.id));
      writeLedger(ledger);
      console.log(`deleted ${del.length} of ${ids.length}`);
      return;
    }

    if (action === "create-tx") {
      const aoc = (await q("select id from public.aocs where code = 'MY'"))[0]?.id ?? fail("no MY aoc");
      const creator = account("aso").authUserId;
      const plan = [{ station: "PEN", number: "ICMS-2026-990001" }, { station: "JHB", number: "ICMS-2026-990002" }];
      for (const x of plan) if ((await q("select 1 from public.transactions where transaction_number = $1", [x.number])).length) fail(`${x.number} already exists`);
      console.log(`plan: ${plan.map((x) => `${x.number}@${x.station}`).join(", ")} (CREATED, OUTBOUND, AIRCRAFT)`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      await client.query("BEGIN");
      try {
      // synthetic movements cannot be on the real vehicle/driver whitelist: bypass the whitelist trigger for THIS transaction only
      await client.query("set local session_replication_role = replica");
      for (const x of plan) {
        const st = (await q("select id from public.org_stations where code = $1", [x.station]))[0]?.id ?? fail(`no station ${x.station}`);
        const r = (await q(
          `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
           values ($1,$2,'OUTBOUND','UAT-VEH','${TAG} SYNTHETIC','UAT-DRV','UAT-SEAL','CREATED','AIRCRAFT',$3,'AK9001',$4) returning id`,
          [x.number, aoc, st, creator],
        ))[0];
        ledger.tx.push({ id: r.id, number: x.number, station: x.station });
      }
      await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      writeLedger(ledger);
      console.log(`created ${ledger.tx.length} synthetic movements: ${ledger.tx.map((t) => t.id).join(", ")}`);
      return;
    }

    if (action === "cleanup-tx") {
      const ids = ledger.tx.map((t) => t.id);
      console.log(`ledger transaction ids: ${ids.length}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      const del = await q("delete from public.transactions where id = any($1::uuid[]) and driver_name like $2 returning id", [ids, `${TAG}%`]);
      ledger.tx = ledger.tx.filter((t) => !del.some((r) => r.id === t.id));
      writeLedger(ledger);
      console.log(`deleted ${del.length} of ${ids.length}`);
      return;
    }

    if (action === "create-reports") {
      const sub = account(SUBMITTER);
      const prof = (await q("select id, station, team, name, staff_no, status from public.profiles where id = $1", [sub.authUserId]))[0] ?? fail("no submitter profile");
      if (prof.status !== "approved" || prof.station !== DUTY_ACCOUNTS[SUBMITTER] || !prof.team) fail("submitter profile is not the expected approved station officer with a team");
      console.log(`plan: ${REPORTS.map((r) => `${r.key} ${r.flight} ${r.reg}`).join("; ")} submitted by ${SUBMITTER} (${prof.station}/${prof.team}) dated ${today}`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      for (const r of REPORTS) {
        await client.query("BEGIN");
        try {
          await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: prof.id, role: "authenticated" })]);
          const syn = `${TAG} SYNTHETIC UAT report - no real data`;
          const row = (await q(
            `insert into public.report_sec016 (profile_id, status, submitted_at, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by,
               aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, inbound_baggage, outbound_baggage, inbound_cargo, outbound_cargo, inbound_co_mail, outbound_co_mail,
               shift_leader, ramp_staff_1, ramp_staff_2, ramp_staff_3, ramp_staff_4, ramp_staff_5, cargo_hold_checked, staff_frisked, discrepancies,
               offload_flight_no, offload_destination, offload_baggage_tag_no, offload_total_baggage, offload_remark)
             values ($1,'submitted', now(), $2,$3,$4,$5,$6::date,'10:00',$7,'ARR/KUL','UAT','A320',$8,'10:00','10:15','UAT-1','NO','0','0','0','0','0','0',
               'UAT','UAT','UAT','UAT','UAT','UAT','NO','NO',$9,'N/A','N/A','N/A','0',$9) returning id`,
            [prof.id, prof.station, prof.team, prof.name, prof.staff_no, today, r.flight, r.reg, syn],
          ))[0];
          await client.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [row.id]);
          await client.query("RESET ROLE");
          await client.query("COMMIT");
          ledger.reports.push({ key: r.key, id: row.id, table: "report_sec016", flight: r.flight, reg: r.reg, date: today });
          writeLedger(ledger);
        } catch (e) { await client.query("ROLLBACK"); throw e; }
      }
      // the queue worker sets its own transaction-local service-role context (migration 20261106000001)
      await q("select * from public.process_report_index_queue(50)");
      for (const rep of ledger.reports) {
        const idx = (await q("select id, operating_entity_code, status from public.central_reports_index where source_table = 'report_sec016' and source_id = $1", [rep.id]))[0];
        rep.indexId = idx?.id ?? null;
        rep.entity = idx?.operating_entity_code ?? null;
        console.log(`${rep.key}: source ${rep.id} indexed as ${rep.indexId} entity=${rep.entity}`);
        if (rep.entity !== rep.key) fail(`${rep.key} report was classified as ${rep.entity}`);
      }
      writeLedger(ledger);
      return;
    }

    if (action === "cleanup-reports") {
      const ids = ledger.reports.map((r) => r.id);
      console.log(`ledger report ids: ${ids.length}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      await client.query("BEGIN");
      try {
        await client.query("set local session_replication_role = replica"); // the submitted-report mutation guard blocks deletes; scoped to this transaction
        const owned = (await q(`select id from public.report_sec016 where id = any($1::uuid[]) and discrepancies like $2`, [ids, `${TAG}%`])).map((r) => r.id);
        if (owned.length !== ids.length) fail("a ledger report no longer carries the run tag; refusing to delete");
        await q("delete from public.user_notifications where payload->>'source_id' = any($1::text[])", [ids]);
        await q("delete from public.report_classification_review_queue where source_id = any($1::uuid[])", [ids]).catch(() => {});
        await q("delete from public.report_access_grants where repository_report_id in (select id from public.central_reports_index where source_id = any($1::uuid[]))", [ids]);
        await q("delete from public.report_versions where repository_report_id in (select id from public.central_reports_index where source_id = any($1::uuid[]))", [ids]);
        await q("delete from public.report_access_requests where repository_report_id in (select id from public.central_reports_index where source_id = any($1::uuid[]))", [ids]);
        await q("delete from public.report_access_audit where repository_report_id in (select id from public.central_reports_index where source_id = any($1::uuid[]))", [ids]);
        await q("delete from public.investigation_case_reports where repository_report_id in (select id from public.central_reports_index where source_id = any($1::uuid[]))", [ids]);
        await q("delete from public.central_reports_index where source_id = any($1::uuid[])", [ids]);
        await q("delete from public.report_index_queue where source_id = any($1::uuid[])", [ids]);
        const del = await q("delete from public.report_sec016 where id = any($1::uuid[]) returning id", [ids]);
        await client.query("COMMIT");
        ledger.reports = [];
        writeLedger(ledger);
        console.log(`deleted ${del.length} synthetic reports with their index / queue / notification rows (audit-log entries are append-only and remain)`);
      } catch (e) { await client.query("ROLLBACK"); throw e; }
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
