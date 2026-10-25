#!/usr/bin/env node
// Read-only preflight for the final hosted UAT. Writes nothing. Exit 0 only if every check passes.
//   node --env-file=.env.local scripts/staging/uat-preflight.mjs --run-id=<id> --app-commit=<sha> --expect-duty=0|16
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import { environmentGates, connectVerified, FORBIDDEN_REF, APPROVED_REF } from "./lib/run-gates.mjs";
import { DUTY_LABELS, dbClock, inactiveDutyLabels } from "./lib/uat-duty.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { EXPECTED_MIGRATION_COUNT, EXPECTED_LATEST_MIGRATION } from "./lib/expected-baseline.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const runId = argVal("run-id");
const appCommit = argVal("app-commit");
const maxRunMinutes = Number.parseInt(argVal("max-run-minutes") ?? "360", 10);
const expectDuty = Number.parseInt(argVal("expect-duty") ?? "0", 10);
if (!runId || !appCommit) throw new Error("--run-id and --app-commit are required");
let failures = 0;
const check = (label, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); };

environmentGates();
check("production reference absent from the environment", !JSON.stringify(process.env).includes(FORBIDDEN_REF));
const dbUrl = new URL(process.env.STAGING_DATABASE_URL);
check("database target is the approved staging project only", (dbUrl.hostname + dbUrl.username).includes(APPROVED_REF) && !(dbUrl.hostname + dbUrl.username).includes(FORBIDDEN_REF));
check("Supabase URL is the approved staging project", new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.startsWith(APPROVED_REF));

// application code identity: only tooling/tests/docs may differ from the tested application commit
const changed = child_process.execSync(`git diff --name-only ${appCommit} HEAD`, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const appChanged = changed.filter((f) => !/^(scripts\/|tests\/|docs\/)/.test(f));
check(`HEAD differs from the tested application commit ${appCommit.slice(0, 7)} only in scripts/tests/docs`, appChanged.length === 0, `${changed.length} file(s) changed${appChanged.length ? "; APPLICATION/MIGRATION: " + appChanged.join(",") : ""}`);
check("working tree is clean", child_process.execSync("git status --porcelain", { encoding: "utf8" }).trim() === "");

// no other automation running
const me = process.pid;
let procs = "";
try {
  procs = child_process.execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'hosted-uat|uat-fixtures|vercel@|playwright_chromiumdev_profile|--test tests|next (build|dev)|migrate\\.mjs|run_harness|verify_.*\\.mjs' -and $_.ProcessId -ne ${me} -and $_.CommandLine -notmatch 'uat-preflight' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name }"`, { encoding: "utf8" }).trim();
} catch { procs = ""; }
const pgRunning = (() => { try { return child_process.execSync('tasklist /FI "IMAGENAME eq postgres.exe"', { encoding: "utf8" }).includes("postgres.exe"); } catch { return false; } })();
check("no other UAT / browser automation / fixture / deployment / test / migration process is running", procs === "", procs.replace(/\r?\n/g, "; "));
check("no disposable PostgreSQL process is running", !pgRunning);

const { client } = await connectVerified();
const q = async (s, p) => (await client.query(s, p)).rows;
const manifest = loadCurrentManifest();
const ledger = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-uat-fixtures", `${runId}.json`), "utf8"));
try {
  const m = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
  check(`staging has ${EXPECTED_MIGRATION_COUNT} migrations ending at ${EXPECTED_LATEST_MIGRATION}`, m.n === EXPECTED_MIGRATION_COUNT && m.v === EXPECTED_LATEST_MIGRATION, `${m.n} / ${m.v}`);
  const clock = await dbClock(client);
  console.log(`INFO: staging clock ${clock.nowUtc}; Malaysia date ${clock.myDate}; ${Math.floor(clock.secondsLeft / 60)} min to Malaysia midnight`);
  const T = `[UAT:${runId}]%`;
  const notThis = (col) => `${col} like '[UAT:%' and ${col} not like '${T.replace(/'/g, "''")}'`;
  const n = async (sql, p) => (await q(sql, p))[0].n;

  // exactly one complete fresh fixture set
  check("reports: exactly the 2 recorded synthetic reports exist (and nothing else is tagged)", (await n("select count(*)::int n from public.report_sec016 where id = any($1::uuid[]) and discrepancies like $2", [ledger.reports.map((r) => r.id), T])) === 2 && (await n(`select count(*)::int n from public.report_sec016 where discrepancies like '[UAT:%'`)) === 2);
  const idx = await q("select operating_entity_code e from public.central_reports_index where source_id = any($1::uuid[]) order by 1", [ledger.reports.map((r) => r.id)]);
  check("both reports are indexed with the server-derived entities AAX and MAA", idx.map((r) => r.e).join() === "AAX,MAA");
  check("movements: exactly the 2 recorded synthetic movements exist", (await n("select count(*)::int n from public.transactions where id = any($1::uuid[]) and driver_name like $2", [ledger.tx.map((t) => t.id), T])) === 2 && (await n(`select count(*)::int n from public.transactions where driver_name like '[UAT:%'`)) === 2);
  check("notifications: exactly the 6 recorded notifications exist and ALL are unread", ledger.notifications.length === 6 && (await n("select count(*)::int n from public.user_notifications where id = any($1::uuid[]) and read_at is null and dedup_key like $2", [ledger.notifications.map((x) => x.id), `uat:${runId}:%`])) === 6 && (await n("select count(*)::int n from public.user_notifications where dedup_key like 'uat:%'")) === 6);
  const dutyAll = await n(`select count(*)::int n from public.duty_records where handover_notes like '[UAT:%'`);
  check(`duty rows: ${expectDuty} tagged row(s) exist (expected ${expectDuty}), none from any other run`, dutyAll === expectDuty && (await n(`select count(*)::int n from public.duty_records where ${notThis("handover_notes")}`)) === 0 && ledger.duty.length === expectDuty);
  if (expectDuty > 0) {
    check("every duty fixture is dated today (Malaysia) and ACTIVE through the duty-gate predicate under RLS", (await inactiveDutyLabels(client, ledger.duty, manifest)).length === 0 && ledger.duty.every((d) => d.date === clock.myDate) && DUTY_LABELS.every((l) => ledger.duty.some((d) => d.label === l)));
  }
  check(`the Malaysia-midnight window is sufficient for a ${maxRunMinutes} min run plus 45 min margin`, clock.secondsLeft >= (maxRunMinutes + 45) * 60, `${Math.floor(clock.secondsLeft / 60)} min left`);
} finally {
  await client.end();
}
console.log(failures ? `\nPREFLIGHT FAILED (${failures})` : "\nPREFLIGHT PASSED");
process.exit(failures ? 1 : 0);
