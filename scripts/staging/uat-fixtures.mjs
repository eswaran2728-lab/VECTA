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
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-partb|cleanup-partb --run-id=<id> [--live]   (tagged Part B movements WITH seals plus a tagged whitelisted vehicle/driver; cleanup deletes the recorded ids, their cascading checkpoint rows and their escalation notifications)
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-tx|cleanup-tx --run-id=<id> [--live]   (two synthetic CaterLink movements, origin PEN and JHB, for the scanner / duty-gate probe)
//   node --env-file=.env.local scripts/staging/uat-fixtures.mjs --action=create-activity|cleanup-activity --run-id=<id> [--live]   (needs create-tx first: tagged checkpoint / receipt rows with KNOWN actors, to prove My Recent Activity lists only the signed-in officer's own actions)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { environmentGates, connectVerified, FORBIDDEN_REF, APPROVED_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { DUTY_LABELS, dbClock, inactiveDutyLabels } from "./lib/uat-duty.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const action = argVal("action");
const runId = argVal("run-id");
const LIVE = args.includes("--live");

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
const readLedger = () => ({ duty: [], reports: [], tx: [], activity: [], partb: null, notifications: [], ...(fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId }) });
const writeLedger = (l) => fs.writeFileSync(ledgerPath, JSON.stringify(l, null, 2), { mode: 0o600 });
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function main() {
  if (!["status", "create-duty", "cleanup-duty", "create-reports", "cleanup-reports", "create-tx", "cleanup-tx", "create-partb", "cleanup-partb", "create-notifications", "cleanup-notifications", "create-activity", "cleanup-activity", "verify-duty"].includes(action)) fail("unknown --action");
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
    const clock = await dbClock(client);
    const today = clock.myDate; // the Malaysia operational date, read from the STAGING DATABASE

    if (action === "status") {
      console.log(JSON.stringify({ duty: ledger.duty.length, reports: ledger.reports.length, ledger: path.basename(ledgerPath) }));
      return;
    }

    if (action === "verify-duty") {
      const bad = await inactiveDutyLabels(client, ledger.duty, manifest);
      console.log(`db now=${clock.nowUtc} my-date=${clock.myDate} seconds-left=${clock.secondsLeft}; fixture entries=${ledger.duty.length}; inactive=${bad.length}${bad.length ? " (" + bad.join(",") + ")" : ""}`);
      if (bad.length || ledger.duty.some((d) => d.date !== clock.myDate)) fail("duty fixtures are not all active for the current Malaysia date");
      return;
    }

    if (action === "create-duty") {
      // ONE active row per required account, for the CURRENT Malaysia date; refuse when the date would roll over during the run.
      const maxRunMin = Number.parseInt(argVal("max-run-minutes") ?? "360", 10);
      const marginMin = Number.parseInt(argVal("margin-minutes") ?? "45", 10);
      const need = (maxRunMin + marginMin) * 60;
      console.log(`staging clock: now=${clock.nowUtc}; Malaysia date=${clock.myDate}; ${Math.floor(clock.secondsLeft / 60)} min until Malaysia midnight; required ${maxRunMin}+${marginMin} min`);
      if (clock.secondsLeft < need) fail("not enough time before Malaysia midnight for the configured run plus margin; refusing to create duty fixtures");
      if (ledger.duty.length) fail("this run already holds duty fixtures; clean them up first (idempotent: nothing is created twice)");
      const plan = [];
      const only = argVal("labels")?.split(",");
      if (only && !only.every((l) => DUTY_LABELS.includes(l))) fail("--labels may only name fixture accounts");
      for (const label of (only ?? DUTY_LABELS)) {
        const a = account(label);
        const p = (await q("select id, station, status from public.profiles where id = $1", [a.authUserId]))[0] ?? fail(`${label}: no profile`);
        if (p.status !== "approved" || !p.station) fail(`${label}: profile is not an approved station officer`);
        const existing = (await q("select count(*)::int n from public.duty_records where profile_id = $1 and duty_date = $2::date", [p.id, today]))[0].n;
        if (existing) fail(`${label}: a duty record already exists for ${today} (real or earlier fixture); refusing to collide`);
        plan.push({ label, profileId: p.id, station: p.station });
      }
      console.log(`plan: ${plan.length} accounts (${plan.map((x) => `${x.label}@${x.station}`).join(", ")}) for ${today}`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      await client.query("BEGIN");
      try {
        for (const x of plan) {
          const r = (await q(
            `insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, check_in_inside_fence, status, handover_notes)
             values ($1, $2, $3::date, 'UAT', now(), true, 'present', $4) returning id`,
            [x.profileId, x.station, today, TAG],
          ))[0];
          ledger.duty.push({ id: r.id, label: x.label, date: today, validUntilSecondsAfterCreate: clock.secondsLeft });
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      writeLedger(ledger);
      const bad = await inactiveDutyLabels(client, ledger.duty, manifest);
      if (bad.length) fail(`created fixtures are not active through the duty-gate predicate: ${bad.join(",")}`);
      console.log(`created ${plan.length} duty rows, all verified active through the duty-gate predicate under RLS: ${ledger.duty.map((d) => d.id).join(", ")}`);
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
      if (ledger.notifications.length) fail("this run already holds notifications; never reuse a consumed notification: clean up and use a NEW run id");
      if (!LIVE) return console.log("DRY RUN: nothing written");
      for (const l of labels) {
        const pid = account(l).authUserId;
        const key = `uat:${runId}:${l}`;
        await q("select public.notify($1, 'request_submitted', $2, null, null, null, $3::jsonb)", [pid, key, JSON.stringify({ uat: runId })]);
        const row = (await q("select id from public.user_notifications where dedup_key = $1", [key]))[0];
        const st = (await q("select read_at from public.user_notifications where id = $1", [row.id]))[0];
        if (st.read_at !== null) fail(`notification for ${l} is not unread immediately after creation`);
        ledger.notifications.push({ id: row.id, label: l, profileId: pid, createdUnread: true });
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
      const creator = account("caterlink-driver").authUserId; // a neutral creator: no station officer may see a movement merely by having created it
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

    if (action === "create-activity") {
      if (ledger.activity.length) fail("this run already holds activity fixtures; clean them up first");
      const pen = ledger.tx.find((t) => t.station === "PEN");
      const jhb = ledger.tx.find((t) => t.station === "JHB");
      if (!pen || !jhb) fail("run create-tx for this run first: the activity rows hang off its two synthetic movements");
      // Known actors: aso (PEN) acts twice; profiling_aso (PEN) and aso-jhb (JHB) each act once, so the signed-in officer's own list can be told apart from visible-but-foreign actions.
      const plan = [
        { table: "part_b_c", stage: "B", tx: pen, by: "aso", minutes: 90 },
        { table: "part_b_c", stage: "C", tx: pen, by: "profiling_aso", minutes: 60 },
        { table: "part_b_c", stage: "B", tx: jhb, by: "aso-jhb", minutes: 45 },
        { table: "caterlink_checkpoint_hub", tx: pen, by: "aso", minutes: 30 },
      ];
      console.log(`plan: ${plan.map((p) => `${p.table}${p.stage ? "/" + p.stage : ""}@${p.tx.station} by ${p.by}`).join(", ")}`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      await client.query("BEGIN");
      try {
        await client.query("set local session_replication_role = replica"); // synthetic rows: skip the checkpoint-recording triggers for THIS transaction only
        for (const p of plan) {
          const a = account(p.by);
          const prof = (await q("select name, staff_no from public.profiles where id = $1", [a.authUserId]))[0] ?? fail(`${p.by}: no profile`);
          const r = p.table === "part_b_c"
            ? (await q(
              `insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, signature_url, result, remarks, completed_by, completed_at)
               values ($1,$2,$3,$4,'uat/fixture','PASS',$5,$6, now() - ($7 || ' minutes')::interval) returning id`,
              [p.tx.id, p.stage, prof.name, prof.staff_no ?? "UAT", TAG, a.authUserId, String(p.minutes)],
            ))[0]
            : (await q(
              `insert into public.caterlink_checkpoint_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, remarks, completed_by, completed_at)
               values ($1,$2,$3,$4,'uat/fixture',$5,$6, now() - ($7 || ' minutes')::interval) returning id`,
              [p.tx.id, p.tx.station, prof.name, prof.staff_no ?? "UAT", TAG, a.authUserId, String(p.minutes)],
            ))[0];
          ledger.activity.push({ id: r.id, table: p.table, by: p.by, station: p.tx.station });
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      writeLedger(ledger);
      console.log(`created ${ledger.activity.length} activity rows: ${ledger.activity.map((x) => `${x.table}:${x.by}`).join(", ")}`);
      return;
    }

    if (action === "cleanup-activity") {
      console.log(`ledger activity rows: ${ledger.activity.length}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      let deleted = 0;
      for (const x of ledger.activity) {
        // exact id AND still carrying this run's tag; the tables are append-only for normal sessions, so this runs as the owner connection
        const del = await q(`delete from public.${x.table === "part_b_c" ? "part_b_c" : "caterlink_checkpoint_hub"} where id = $1 and remarks = $2 returning id`, [x.id, TAG]);
        deleted += del.length;
      }
      ledger.activity = [];
      writeLedger(ledger);
      console.log(`deleted ${deleted}`);
      return;
    }

    if (action === "create-partb") {
      if (ledger.partb) fail("this run already holds Part B fixtures");
      const aoc = (await q("select id from public.aocs where code = 'MY'"))[0]?.id ?? fail("no MY aoc");
      const creator = account("caterlink-driver").authUserId;
      const k = runId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
      const VEH = `UATPB${k}`;
      const DRV = `UATPD${k}`;
      const plan = [
        { key: "pen-pass", station: "PEN", status: "CREATED" },
        { key: "pen-escalate", station: "PEN", status: "CREATED" },
        { key: "jhb-pass", station: "JHB", status: "CREATED" },
        { key: "pen-wrong-state", station: "PEN", status: "INFLIGHT_POST_APPROVED" },
        { key: "pen-concurrent", station: "PEN", status: "CREATED" },
        { key: "jhb-denial", station: "JHB", status: "CREATED" },
        { key: "pen-layout", station: "PEN", status: "CREATED" },
      ];
      console.log(`plan: tagged caterer + vehicle ${VEH} + driver ${DRV}; ${plan.length} OUTBOUND movements (${plan.map((x) => `${x.key}@${x.station}/${x.status}`).join(", ")}), one tagged TRUCK_SEAL each`);
      if (!LIVE) return console.log("DRY RUN: nothing written");
      await client.query("BEGIN");
      try {
        const co = (await q("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ($1,$2,$3,'active',true,current_date - 1) returning id", [`${TAG} PartB caterer`, `UPB${k}`, aoc]))[0].id;
        const veh = (await q("insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ($1,$2,$3,'active',true,current_date - 1) returning id", [VEH, co, aoc]))[0].id;
        const drv = (await q("insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ($1,$2,$3,$4,'active',true,current_date - 1) returning id", [`${TAG} PartB driver`, DRV, co, aoc]))[0].id;
        ledger.partb = { company: co, vehicle: veh, driver: drv, vehicleNumber: VEH, driverName: `${TAG} PartB driver`, driverStaffId: DRV, sealNumber: `UATSEAL${k}`, sealColor: "BLUE" };
        await client.query("set local session_replication_role = replica");
        let n = 990100;
        for (const x of plan) {
          n += 1;
          const number = `ICMS-2026-${n}`;
          if ((await q("select 1 from public.transactions where transaction_number = $1", [number])).length) fail(`${number} already exists`);
          const st = (await q("select id from public.org_stations where code = $1", [x.station]))[0]?.id ?? fail(`no station ${x.station}`);
          const r = (await q(
            `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
             values ($1,$2,'OUTBOUND',$3,$4,$5,$6,$7,'AIRCRAFT',$8,'AK9001',$9) returning id`,
            [number, aoc, VEH, `${TAG} SYNTHETIC`, DRV, ledger.partb.sealNumber, x.status, st, creator],
          ))[0];
          const seal = (await q("insert into public.seals (transaction_id, seal_number, seal_type, seal_color) values ($1,$2,'TRUCK_SEAL',$3) returning id", [r.id, ledger.partb.sealNumber, "BLUE"]))[0].id;
          ledger.tx.push({ id: r.id, number, station: x.station, key: x.key, sealId: seal });
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); ledger.partb = null; ledger.tx = []; throw e; }
      writeLedger(ledger);
      console.log(`created Part B fixtures: ${ledger.tx.length} movements, ${ledger.tx.length} seals, 1 caterer, 1 vehicle, 1 driver`);
      return;
    }

    if (action === "cleanup-partb") {
      const ids = ledger.tx.map((t) => t.id);
      console.log(`ledger: ${ids.length} movements; whitelist rows: ${ledger.partb ? 3 : 0}`);
      if (!LIVE) return console.log("DRY RUN: nothing deleted");
      await client.query("BEGIN");
      try {
        // counts BEFORE deletion, by recorded ids only (children cascade from the transaction row)
        const cnt = async (sql, p) => (await q(sql, p))[0].n;
        const before = {
          partB: await cnt("select count(*)::int n from public.part_b_c where transaction_id = any($1::uuid[])", [ids]),
          sealVerifications: await cnt("select count(*)::int n from public.seal_verifications where seal_id in (select id from public.seals where transaction_id = any($1::uuid[]))", [ids]),
          seals: await cnt("select count(*)::int n from public.seals where transaction_id = any($1::uuid[])", [ids]),
          incidents: await cnt("select count(*)::int n from public.caterlink_incidents where transaction_id = any($1::uuid[])", [ids]),
        };
        // notifications raised by those movements' escalations (dedup key cp_esc:<tx>:<incident>:<profile>) -- only the recorded transactions
        const nIds = ids.length ? (await q("select id from public.user_notifications where " + ids.map((_, i) => `dedup_key like $${i + 1}`).join(" or "), ids.map((i) => `cp_esc:${i}:%`))).map((r) => r.id) : [];
        const delN = nIds.length ? (await q("delete from public.user_notifications where id = any($1::uuid[]) returning id", [nIds])).length : 0;
        const delTx = (await q("delete from public.transactions where id = any($1::uuid[]) and driver_name like $2 returning id", [ids, `${TAG}%`])).length;
        let delWl = 0;
        if (ledger.partb) {
          delWl += (await q("delete from public.vehicles where id = $1 and vehicle_number = $2 returning id", [ledger.partb.vehicle, ledger.partb.vehicleNumber])).length;
          delWl += (await q("delete from public.drivers where id = $1 and staff_id = $2 returning id", [ledger.partb.driver, ledger.partb.driverStaffId])).length;
          delWl += (await q("delete from public.catering_companies where id = $1 and name like $2 returning id", [ledger.partb.company, `${TAG}%`])).length;
        }
        await client.query("COMMIT");
        const left = await cnt("select count(*)::int n from public.transactions where id = any($1::uuid[])", [ids]);
        if (left === 0) { ledger.tx = []; ledger.partb = null; }
        writeLedger(ledger);
        console.log(`deleted: transactions=${delTx}/${ids.length}; cascaded part_b_c=${before.partB}, seal_verifications=${before.sealVerifications}, seals=${before.seals}, incidents=${before.incidents}; notifications=${delN}; whitelist rows=${delWl}/3 (audit-log entries are append-only and remain); transactions left=${left}`);
      } catch (e) { await client.query("ROLLBACK"); throw e; }
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
      if (prof.status !== "approved" || prof.station !== "KUL - MAA" || !prof.team) fail("submitter profile is not the expected approved station officer with a team");
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
