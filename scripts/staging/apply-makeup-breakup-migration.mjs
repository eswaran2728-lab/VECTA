#!/usr/bin/env node
// Guarded runner for applying the approved Makeup and Breakup reports forward migration to staging.
// Staging ONLY: ddlctzbnqewubltcavkh. Production (zsxneokqulktgnccxgkz) is strictly rejected.
//
// Usage:
//   node --env-file=.env.local scripts/staging/apply-makeup-breakup-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-makeup-breakup-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261129000001 TO STAGING ddlctzbnqewubltcavkh"
//   node --env-file=.env.local scripts/staging/apply-makeup-breakup-migration.mjs --verify-applied                                            (read-only)
//   node --env-file=.env.local scripts/staging/apply-makeup-breakup-migration.mjs --observe                                                   (read-only pre-state)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261129000001", name: "add_makeup_and_breakup_reports", sha256: "e04d1c556b6d904fce47cd9de6c2eb3536b897c0ce4bed094767e2dfd7989839" },
];

export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
export const PUSHED_BASE = "c2b4458f989abb89c7756fe9946aae7ea2aabc65";
export const PRE_COUNT = 102;
export const LAST_PRE = "20261128000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const md5 = (t) => crypto.createHash("md5").update(String(t ?? "")).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^create table if not exists public\.report_makeup \(.*\)$/,
  /^create table if not exists public\.report_makeup_baggage_entries \(.*\)$/,
  /^create table if not exists public\.report_makeup_discrepancies \(.*\)$/,
  /^create index if not exists idx_report_makeup_profile_id on public\.report_makeup\(profile_id\)$/,
  /^create index if not exists idx_report_makeup_station_team on public\.report_makeup\(station, team\)$/,
  /^create index if not exists idx_report_makeup_report_no on public\.report_makeup\(report_no\)$/,
  /^create index if not exists idx_report_makeup_duty_date on public\.report_makeup\(duty_date\)$/,
  /^create index if not exists idx_report_makeup_baggage_entries_report_id on public\.report_makeup_baggage_entries\(report_id\)$/,
  /^create index if not exists idx_report_makeup_discrepancies_report_id on public\.report_makeup_discrepancies\(report_id\)$/,
  /^create table if not exists public\.report_breakup \(.*\)$/,
  /^create table if not exists public\.report_breakup_baggage_entries \(.*\)$/,
  /^create index if not exists idx_report_breakup_profile_id on public\.report_breakup\(profile_id\)$/,
  /^create index if not exists idx_report_breakup_station_team on public\.report_breakup\(station, team\)$/,
  /^create index if not exists idx_report_breakup_report_no on public\.report_breakup\(report_no\)$/,
  /^create index if not exists idx_report_breakup_duty_date on public\.report_breakup\(duty_date\)$/,
  /^create index if not exists idx_report_breakup_baggage_entries_report_id on public\.report_breakup_baggage_entries\(report_id\)$/,
  /^create trigger report_makeup_set_updated_at before update on public\.report_makeup for each row execute function public\.set_updated_at\(\)$/,
  /^create trigger report_makeup_immutable before update or delete on public\.report_makeup for each row execute function public\.block_submitted_report_mutation\(\)$/,
  /^create or replace function public\.block_submitted_child_mutation_makeup\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.block_submitted_child_mutation_makeup\(\) from public, anon, authenticated$/,
  /^grant execute on function public\.block_submitted_child_mutation_makeup\(\) to service_role$/,
  /^create trigger report_makeup_baggage_entries_immutable before update or delete on public\.report_makeup_baggage_entries for each row execute function public\.block_submitted_child_mutation_makeup\(\)$/,
  /^create trigger report_makeup_discrepancies_immutable before update or delete on public\.report_makeup_discrepancies for each row execute function public\.block_submitted_child_mutation_makeup\(\)$/,
  /^create trigger report_breakup_set_updated_at before update on public\.report_breakup for each row execute function public\.set_updated_at\(\)$/,
  /^create trigger report_breakup_immutable before update or delete on public\.report_breakup for each row execute function public\.block_submitted_report_mutation\(\)$/,
  /^create or replace function public\.block_submitted_child_mutation_breakup\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.block_submitted_child_mutation_breakup\(\) from public, anon, authenticated$/,
  /^grant execute on function public\.block_submitted_child_mutation_breakup\(\) to service_role$/,
  /^create trigger report_breakup_baggage_entries_immutable before update or delete on public\.report_breakup_baggage_entries for each row execute function public\.block_submitted_child_mutation_breakup\(\)$/,
  /^create or replace function public\.next_report_no\(p_form_code text, p_report_date date\) returns text language plpgsql security definer set search_path = public as ''$/,
  /^create or replace function public\.set_report_no_makeup\(\) returns trigger language plpgsql security definer set search_path = public as ''$/,
  /^drop trigger if exists trg_set_report_no_makeup on public\.report_makeup$/,
  /^create trigger trg_set_report_no_makeup before insert or update on public\.report_makeup for each row execute function public\.set_report_no_makeup\(\)$/,
  /^create or replace function public\.set_report_no_breakup\(\) returns trigger language plpgsql security definer set search_path = public as ''$/,
  /^drop trigger if exists trg_set_report_no_breakup on public\.report_breakup$/,
  /^create trigger trg_set_report_no_breakup before insert or update on public\.report_breakup for each row execute function public\.set_report_no_breakup\(\)$/,
  /^alter table public\.report_form_assignments drop constraint if exists report_form_assignments_form_type_check$/,
  /^alter table public\.report_form_assignments add constraint report_form_assignments_form_type_check check \(form_type in \(.*\)\)$/,
  /^insert into public\.report_form_assignments \(role_code, station_code, profile_id, form_type, note\) select .*/,
  /^create or replace function public\.list_my_report_forms_secure\(\) returns table \(form_type text\) language sql stable security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.enforce_report_form_assignment\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
  /^drop trigger if exists trg_enforce_form_assignment on public\.report_makeup$/,
  /^create trigger trg_enforce_form_assignment before insert on public\.report_makeup for each row execute function public\.enforce_report_form_assignment\(\)$/,
  /^drop trigger if exists trg_enforce_form_assignment on public\.report_breakup$/,
  /^create trigger trg_enforce_form_assignment before insert on public\.report_breakup for each row execute function public\.enforce_report_form_assignment\(\)$/,
  /^create or replace function public\.set_report_classification_fields\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
  /^drop trigger if exists trg_set_classification on public\.report_makeup$/,
  /^create trigger trg_set_classification before insert or update on public\.report_makeup for each row execute function public\.set_report_classification_fields\(\)$/,
  /^drop trigger if exists trg_set_classification on public\.report_breakup$/,
  /^create trigger trg_set_classification before insert or update on public\.report_breakup for each row execute function public\.set_report_classification_fields\(\)$/,
  /^create or replace function public\.enqueue_unclassified_flight_report\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
  /^drop trigger if exists trg_unclassified_flight_report on public\.report_makeup$/,
  /^create trigger trg_unclassified_flight_report after insert on public\.report_makeup for each row execute function public\.enqueue_unclassified_flight_report\(\)$/,
  /^drop trigger if exists trg_unclassified_flight_report on public\.report_breakup$/,
  /^create trigger trg_unclassified_flight_report after insert on public\.report_breakup for each row execute function public\.enqueue_unclassified_flight_report\(\)$/,
  /^alter table public\.central_reports_index drop constraint if exists central_reports_index_source_table_check$/,
  /^alter table public\.central_reports_index add constraint central_reports_index_source_table_check check \(source_table in \(.*\)\)$/,
  /^create or replace function public\.index_report\(.*\) returns uuid language plpgsql security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.report_source_content\(p_source_table text, p_source_id uuid\) returns jsonb language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.report_source_summary\(p_source_table text, p_source_id uuid\) returns table \(.*\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.mark_report_ready_for_indexing\(.*\) returns void language plpgsql security definer set search_path to 'public' as ''$/,
  /^alter table public\.report_drafts drop constraint if exists report_drafts_report_type_check$/,
  /^alter table public\.report_drafts add constraint report_drafts_report_type_check check \(report_type in \(.*\)\)$/,
  /^alter table public\.report_acknowledgements drop constraint if exists report_acknowledgements_report_type_check$/,
  /^alter table public\.report_acknowledgements add constraint report_acknowledgements_report_type_check check \(report_type in \(.*\)\)$/,
  /^alter table public\.report_attachments drop constraint if exists report_attachments_report_type_check$/,
  /^alter table public\.report_attachments add constraint report_attachments_report_type_check check \(report_type in \(.*\)\)$/,
  /^create or replace function public\.get_report_submitter\(p_report_type text, p_report_id uuid\) returns table\(profile_id uuid, station text, team text\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.can_acknowledge_report\(p_report_type text, p_report_id uuid\) returns boolean language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^alter table public\.report_makeup enable row level security$/,
  /^alter table public\.report_makeup_baggage_entries enable row level security$/,
  /^alter table public\.report_makeup_discrepancies enable row level security$/,
  /^alter table public\.report_breakup enable row level security$/,
  /^alter table public\.report_breakup_baggage_entries enable row level security$/,
  /^create policy makeup_own_select on public\.report_makeup for select to authenticated using \(.*\)$/,
  /^create policy makeup_own_insert on public\.report_makeup for insert to authenticated with check \(.*\)$/,
  /^create policy makeup_own_update on public\.report_makeup for update to authenticated using \(.*\) with check \(.*\)$/,
  /^create policy makeup_own_delete on public\.report_makeup for delete to authenticated using \(.*\)$/,
  /^create policy makeup_baggage_entries_select on public\.report_makeup_baggage_entries for select to authenticated using \(.*\)$/,
  /^create policy makeup_baggage_entries_insert on public\.report_makeup_baggage_entries for insert to authenticated with check \(.*\)$/,
  /^create policy makeup_baggage_entries_update on public\.report_makeup_baggage_entries for update to authenticated using \(.*\) with check \(.*\)$/,
  /^create policy makeup_baggage_entries_delete on public\.report_makeup_baggage_entries for delete to authenticated using \(.*\)$/,
  /^create policy makeup_discrepancies_select on public\.report_makeup_discrepancies for select to authenticated using \(.*\)$/,
  /^create policy makeup_discrepancies_insert on public\.report_makeup_discrepancies for insert to authenticated with check \(.*\)$/,
  /^create policy makeup_discrepancies_update on public\.report_makeup_discrepancies for update to authenticated using \(.*\) with check \(.*\)$/,
  /^create policy makeup_discrepancies_delete on public\.report_makeup_discrepancies for delete to authenticated using \(.*\)$/,
  /^create policy breakup_own_select on public\.report_breakup for select to authenticated using \(.*\)$/,
  /^create policy breakup_own_insert on public\.report_breakup for insert to authenticated with check \(.*\)$/,
  /^create policy breakup_own_update on public\.report_breakup for update to authenticated using \(.*\) with check \(.*\)$/,
  /^create policy breakup_own_delete on public\.report_breakup for delete to authenticated using \(.*\)$/,
  /^create policy breakup_baggage_entries_select on public\.report_breakup_baggage_entries for select to authenticated using \(.*\)$/,
  /^create policy breakup_baggage_entries_insert on public\.report_breakup_baggage_entries for insert to authenticated with check \(.*\)$/,
  /^create policy breakup_baggage_entries_update on public\.report_breakup_baggage_entries for update to authenticated using \(.*\) with check \(.*\)$/,
  /^create policy breakup_baggage_entries_delete on public\.report_breakup_baggage_entries for delete to authenticated using \(.*\)$/,
  /^revoke all on public\.report_makeup from public, anon$/,
  /^grant select, insert, update, delete on public\.report_makeup to authenticated$/,
  /^grant all on public\.report_makeup to service_role$/,
  /^revoke all on public\.report_makeup_baggage_entries from public, anon$/,
  /^grant select, insert, update, delete on public\.report_makeup_baggage_entries to authenticated$/,
  /^grant all on public\.report_makeup_baggage_entries to service_role$/,
  /^revoke all on public\.report_makeup_discrepancies from public, anon$/,
  /^grant select, insert, update, delete on public\.report_makeup_discrepancies to authenticated$/,
  /^grant all on public\.report_makeup_discrepancies to service_role$/,
  /^revoke all on public\.report_breakup from public, anon$/,
  /^grant select, insert, update, delete on public\.report_breakup to authenticated$/,
  /^grant all on public\.report_breakup to service_role$/,
  /^revoke all on public\.report_breakup_baggage_entries from public, anon$/,
  /^grant select, insert, update, delete on public\.report_breakup_baggage_entries to authenticated$/,
  /^grant all on public\.report_breakup_baggage_entries to service_role$/,
];

export function statementAudit(sql) {
  const raw = String(sql).replace(/--.*$/gm, "");
  const code = raw.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  const statements = code
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").replace(/([[(]) /g, "$1").replace(/ ([\])])/g, "$1").trim().toLowerCase())
    .filter(Boolean);
  const bad = statements.find((s) => !ALLOWED_STATEMENTS.some((rx) => rx.test(s)));
  if (bad) return bad.slice(0, 140);
  return null;
}

export function verifyFrozenMigrations(readFile) {
  return MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = readFile(file);
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    const sql = canonicalSql(buf);
    const bad = statementAudit(sql);
    if (bad) fail(`${file} contains a statement outside the reviewed allow-list: ${bad}`);
    return { ...m, file, sql };
  });
}

export function orderingGate(fileNames) {
  const dated = fileNames.filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort();
  if (new Set(dated).size !== dated.length) fail("duplicate migration versions in the repository");
  const after = dated.filter((v) => v > LAST_PRE && v <= POST_LAST);
  if (after.join() !== MIGRATIONS.map((m) => m.version).join()) fail(`migrations after ${LAST_PRE} other than frozen (${after.join()})`);
  if (!dated.includes(LAST_PRE)) fail(`${LAST_PRE} is not in the repository`);
}

export function runnerGitGates({ expectedHead, repoPath, base = PUSHED_BASE }) {
  if (!/^[0-9a-f]{40}$/.test(String(expectedHead))) fail("--expected-head must be a full 40-character SHA");
  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: repoPath, expectedBranch: RUNNER_BRANCH });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  try { child_process.execSync(`git merge-base --is-ancestor ${base} HEAD`, { stdio: "ignore" }); } catch { fail("HEAD does not descend from the pushed baseline"); }
  return git;
}

export function productionGate(env = process.env, argv = process.argv) {
  if (JSON.stringify(env).includes(FORBIDDEN_REF) || argv.join(" ").includes(FORBIDDEN_REF)) fail("production reference present");
}

export async function observe(q) {
  const makeupTable = await q("select table_name from information_schema.tables where table_schema='public' and table_name='report_makeup'");
  const breakupTable = await q("select table_name from information_schema.tables where table_schema='public' and table_name='report_breakup'");
  const formAssignments = await q("select count(*)::int as c from public.report_form_assignments where form_type in ('makeup', 'breakup') and revoked_at is null");
  return {
    makeupExists: makeupTable.length > 0,
    breakupExists: breakupTable.length > 0,
    formAssignmentsCount: formAssignments[0].c,
  };
}

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) {
    fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the migration is already recorded in history");
  const obs = await observe(q);
  if (obs.makeupExists) fail("report_makeup already exists in staging");
  if (obs.breakupExists) fail("report_breakup already exists in staging");
  if (obs.formAssignmentsCount > 0) fail("report_form_assignments already has makeup/breakup rows");
  return obs;
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  const expectedCount = ctx.postCount ?? POST_COUNT;
  const expectedLast = ctx.postLast ?? POST_LAST;
  if (mig.length !== expectedCount || mig[mig.length - 1]?.version !== expectedLast) {
    fail(`history is not ${expectedCount} ending ${expectedLast} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  for (const m of MIGRATIONS) {
    if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) {
      fail(`${m.version} is not recorded exactly once with its name`);
    }
  }
  const obs = await observe(q);
  if (!obs.makeupExists) fail("report_makeup was not created");
  if (!obs.breakupExists) fail("report_breakup was not created");
  if (obs.formAssignmentsCount === 0) fail("report_form_assignments has no active makeup/breakup rows");
  return { history: mig.length, last: mig[mig.length - 1].version, obs };
}

export async function execute(client, ctx) {
  const { acct, log } = ctx;
  const files = ctx.files.map((f) => ({ ...f, sql: canonicalSql(f.sql) }));
  for (const f of files) {
    if (f.sha256 && normalisedSha256(f.sql) !== f.sha256) fail(`${f.file}: SQL does not match frozen SHA-256`);
    const bad = statementAudit(f.sql);
    if (bad) fail(`${f.file} statement audit failed: ${bad}`);
  }
  const q = async (s, p) => (await client.query(s, p)).rows;
  const probes = [];
  const probe = (name) => { probes.push(name); log(`PROBE PASS: ${name}`); };

  await verifyPreState(q, { ...ctx, files });
  log(`hosted pre-state verified: 102 migrations ending 20261128000001, report_makeup/breakup absent`);

  const asRole = async (uid, role, fn) => {
    await client.query("SAVEPOINT pr");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
      const res = await fn();
      await client.query("RELEASE SAVEPOINT pr");
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims', '', true)");
      return res;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT pr").catch(() => {});
      await client.query("reset role").catch(() => {});
      await client.query("select set_config('request.jwt.claims', '', true)").catch(() => {});
      return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 110)}`;
    }
  };
  const asUser = (label, fn) => asRole(acct(label), "authenticated", fn);

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      log(`applying migration ${files[0].version}...`);
      await client.query(files[0].sql);

      // Probe 1: Next report no generation
      const rMakeupNo = await q("select public.next_report_no('MAKEUP', '2026-10-28'::date) as no");
      if (!/^AAMKP-20261028-\d{3}$/.test(rMakeupNo[0].no)) fail(`unexpected makeup report_no: ${rMakeupNo[0].no}`);
      const rBreakupNo = await q("select public.next_report_no('BREAKUP', '2026-10-28'::date) as no");
      if (!/^AABKP-20261028-\d{3}$/.test(rBreakupNo[0].no)) fail(`unexpected breakup report_no: ${rBreakupNo[0].no}`);
      probe("next_report_no generates AAMKP and AABKP prefixes with date and sequence");

      // Probe 2: ASO can insert draft report_makeup and report_breakup
      const asoId = acct("aso-kul");
      const TAG = `TEST-${Date.now()}`;
      const draftMakeup = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup (
            profile_id, status, station, team, staff_name, staff_id, flight_number,
            duty_date, destination, first_baggage_time, last_baggage_tag_time
          ) values ($1, 'draft', 'KUL - MAA', 'ALPHA', 'ASO Tester', 'ASO123', 'AK 123', '2026-10-28', 'PEN', '08:00', '09:00')
          returning id`,
          [asoId]
        );
        return res.rows[0].id;
      });
      if (typeof draftMakeup !== "string" || !draftMakeup || draftMakeup.startsWith("ERR")) fail(`ASO draft makeup insert failed: ${draftMakeup}`);
      probe("ASO can insert draft report_makeup");

      // Probe 3: Non-ASO cannot insert report_makeup
      const soDenied = await asUser("so-kul", async () => {
        return await client.query(
          `insert into public.report_makeup (
            profile_id, status, station, team, staff_name, staff_id, flight_number,
            duty_date, destination, first_baggage_time, last_baggage_tag_time
          ) values ($1, 'draft', 'KUL - MAA', 'ALPHA', 'SO Tester', 'SO123', 'AK 123', '2026-10-28', 'PEN', '08:00', '09:00')
          returning id`,
          [acct("so-kul")]
        );
      });
      if (!String(soDenied).startsWith("ERR")) fail(`SO insert was not denied: ${JSON.stringify(soDenied)}`);
      probe("SO insert of report_makeup denied by RLS policy");

      // Probe 4: ASO can add child entries to draft report_makeup
      const childEntry = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
           values ($1, 1, 'AKE12345AK', 'SL-1234', 'B12', 'PEN') returning id`,
          [draftMakeup]
        );
        return res.rows[0].id;
      });
      if (typeof childEntry !== "string" || !childEntry || childEntry.startsWith("ERR")) fail(`Child entry insert failed: ${childEntry}`);
      probe("ASO can insert child baggage entries on draft report_makeup");

      // Probe 5: Submitting report_makeup triggers report_no generation and flight classification (AK -> MAA)
      const submittedMakeup = await asUser("aso-kul", async () => {
        const res = await client.query(
          `update public.report_makeup set status = 'submitted', submitted_at = now(), officer_confirmation = true
           where id = $1 returning report_no, operating_entity_code`,
          [draftMakeup]
        );
        return res.rows[0];
      });
      if (!submittedMakeup || typeof submittedMakeup === "string") fail(`Update failed: ${submittedMakeup}`);
      if (!submittedMakeup.report_no?.startsWith("AAMKP-")) fail(`Submitted makeup missing report_no: ${JSON.stringify(submittedMakeup)}`);
      if (submittedMakeup.operating_entity_code !== "MAA") fail(`Flight AK 123 did not classify to MAA: ${JSON.stringify(submittedMakeup)}`);
      probe("Submitting report_makeup sets AAMKP report_no and classifies AK 123 to MAA");

      // Probe 6: Immutability blocks modification of submitted report_makeup
      const mutateBlocked = await asUser("aso-kul", async () => {
        return await client.query("update public.report_makeup set destination = 'BKI' where id = $1", [draftMakeup]);
      });
      const blocked = String(mutateBlocked).startsWith("ERR") || mutateBlocked?.rowCount === 0;
      if (!blocked) fail(`Submitted makeup mutation was not blocked: ${JSON.stringify(mutateBlocked)}`);
      const checkDest = await q("select destination from public.report_makeup where id = $1", [draftMakeup]);
      if (checkDest[0]?.destination !== "PEN") fail(`destination was mutated: ${checkDest[0]?.destination}`);
      probe("Submitted report_makeup cannot be modified (immutability / RLS enforced)");

      // Probe 7: Immutability blocks child entry modification on submitted report_makeup
      const childMutateBlocked = await asUser("aso-kul", async () => {
        return await client.query(
          `insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
           values ($1, 2, 'AKE99999AK', 'SL-9999', 'B14', 'PEN')`,
          [draftMakeup]
        );
      });
      if (!String(childMutateBlocked).startsWith("ERR")) fail(`Child entry insertion on submitted report was not blocked: ${JSON.stringify(childMutateBlocked)}`);
      probe("Child entries on submitted report_makeup cannot be added/modified");

      // Probe 8: Acknowledgment permissions on report_makeup
      const soCanAck = await asUser("so-kul", async () => {
        const res = await client.query("select public.can_acknowledge_report('makeup', $1) as ok", [draftMakeup]);
        return res.rows[0].ok;
      });
      if (soCanAck !== true) fail(`SO at KUL - MAA ALPHA cannot acknowledge ASO makeup report: ${soCanAck}`);
      const ssoCanAck = await asUser("sso-kul", async () => {
        const res = await client.query("select public.can_acknowledge_report('makeup', $1) as ok", [draftMakeup]);
        return res.rows[0].ok;
      });
      if (ssoCanAck !== true) fail(`SSO at KUL - MAA ALPHA cannot acknowledge ASO makeup report: ${ssoCanAck}`);
      const penSoDenied = await asUser("so", async () => {
        const res = await client.query("select public.can_acknowledge_report('makeup', $1) as ok", [draftMakeup]);
        return res.rows[0].ok;
      });
      if (penSoDenied !== false) fail(`SO at PEN was not denied acknowledging KUL report: ${penSoDenied}`);
      probe("SO and SSO on same station/team can acknowledge; different station denied");

      // Probe 9: Breakup report creation with D7 flight classifies to AAX
      const draftBreakup = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_breakup (
            profile_id, status, station, team, staff_name, staff_id, flight_number,
            duty_date, origin, first_container_time, last_container_time, containers_inspected_clean
          ) values ($1, 'submitted', 'KUL - AAX', 'ALPHA', 'ASO Tester', 'ASO123', 'D7 789', '2026-10-28', 'HND', '22:00', '23:00', true)
          returning id, report_no, operating_entity_code`,
          [asoId]
        );
        return res.rows[0];
      });
      if (!draftBreakup || typeof draftBreakup === "string") fail(`Breakup insert failed: ${draftBreakup}`);
      if (!draftBreakup.report_no?.startsWith("AABKP-")) fail(`Submitted breakup missing report_no: ${JSON.stringify(draftBreakup)}`);
      if (draftBreakup.operating_entity_code !== "AAX") fail(`Flight D7 789 did not classify to AAX: ${JSON.stringify(draftBreakup)}`);
      probe("Breakup report creation with D7 789 classifies to AAX and receives AABKP report_no");

      // Probe 10: report_source_content and report_source_summary
      const srcContent = await q("select public.report_source_content('report_makeup', $1) as c", [draftMakeup]);
      if (!srcContent[0].c?.baggage_entries || srcContent[0].c.baggage_entries.length !== 1) {
        fail(`report_source_content for makeup missing baggage_entries: ${JSON.stringify(srcContent[0].c)}`);
      }
      const srcSummary = await q("select * from public.report_source_summary('report_makeup', $1)", [draftMakeup]);
      if (!srcSummary[0].secondary_identifier?.includes("Flight AK 123")) {
        fail(`report_source_summary missing secondary identifier: ${JSON.stringify(srcSummary[0])}`);
      }
      probe("report_source_content and report_source_summary serialize makeup report and children");

      // Probe 11: list_my_report_forms_secure includes makeup and breakup for ASO
      const forms = await asUser("aso-kul", async () => {
        const res = await client.query("select form_type from public.list_my_report_forms_secure()");
        return res.rows.map((r) => r.form_type);
      });
      if (!forms.includes("makeup") || !forms.includes("breakup")) {
        fail(`list_my_report_forms_secure for ASO does not include makeup/breakup: ${JSON.stringify(forms)}`);
      }
      probe("list_my_report_forms_secure returns makeup and breakup for ASO");

      if (real) {
        log("recording migration in supabase_migrations.schema_migrations...");
        await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [files[0].version, files[0].name]);
        await client.query("COMMIT");
        log("LIVE TRANSACTION COMMITTED.");
      } else {
        await client.query("ROLLBACK");
        log("DRY RUN TRANSACTION ROLLED BACK.");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  log("\n--- STAGE 1: Transactional dry run with 11 behavioral probes ---");
  await pass(false);

  log("\n--- STAGE 2: Verifying pre-state preserved after rollback ---");
  await verifyPreState(q, { ...ctx, files });
  log("Pre-state verified: zero remnants from dry run.");

  if (ctx.live) {
    log("\n--- STAGE 3: LIVE PASS ---");
    await pass(true);
    log("\n--- STAGE 4: Verifying applied schema and history ---");
    const verified = await verifyApplied(q, { ...ctx, files });
    log(`Migration successfully verified live: history = ${verified.history}, last = ${verified.last}`);
  } else {
    log("\nDRY RUN SUCCESSFUL. Pass --live --confirm=\"<LIVE_PHRASE>\" to apply.");
  }

  return { probesCount: probes.length };
}

async function main() {
  const argv = process.argv.slice(2);
  productionGate(process.env, argv);

  const isLive = argv.includes("--live");
  const isVerify = argv.includes("--verify-applied");
  const isObserve = argv.includes("--observe");
  const expectedHeadArg = argv.find((a) => a.startsWith("--expected-head="))?.split("=")[1];
  const backupArg = argv.find((a) => a.startsWith("--backup="))?.split("=")[1];
  const confirmArg = argv.find((a) => a.startsWith("--confirm="))?.split("=")[1];

  const repoPath = path.resolve(import.meta.dirname, "../..");
  const sqlDir = path.join(repoPath, "supabase/migrations");

  const readFile = (file) => fs.readFileSync(path.join(sqlDir, file));
  const frozen = verifyFrozenMigrations(readFile);
  orderingGate(fs.readdirSync(sqlDir));

  if (isObserve) {
    const { client } = await connectVerified();
    try {
      const obs = await observe((s, p) => client.query(s, p).then((r) => r.rows));
      console.log("OBSERVE:", JSON.stringify(obs, null, 2));
    } finally {
      await client.end();
    }
    return;
  }

  if (isVerify) {
    const { client } = await connectVerified();
    try {
      const res = await verifyApplied((s, p) => client.query(s, p).then((r) => r.rows));
      console.log(`VERIFIED APPLIED: history = ${res.history}, last = ${res.last}`);
      console.log(JSON.stringify(res.obs, null, 2));
    } finally {
      await client.end();
    }
    return;
  }

  if (!expectedHeadArg) fail("--expected-head=<sha> is required");
  const git = runnerGitGates({ expectedHead: expectedHeadArg, repoPath });

  if (!backupArg) fail("--backup=<fresh.enc.json> is required");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(backupArg, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(backupArg)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  console.log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  if (isLive && confirmArg !== LIVE_PHRASE) {
    fail(`Confirmation phrase mismatch. Expected: --confirm="${LIVE_PHRASE}"`);
  }

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? manifest.find((a) => a.label === label)?.id ?? fail(`manifest has no ${label}`);

  const { client } = await connectVerified();
  try {
    await execute(client, {
      files: frozen,
      acct,
      live: isLive,
      log: console.log,
      preCount: PRE_COUNT,
      lastPre: LAST_PRE,
      postCount: POST_COUNT,
      postLast: POST_LAST,
    });
  } finally {
    await client.end();
  }
}

const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  main().catch((e) => {
    console.error("FATAL ERROR:", e.stack || e.message);
    process.exit(1);
  });
}
