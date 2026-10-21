#!/usr/bin/env node
// Applies ONLY the frozen forward migration 20261117000001_bay_board_sec016_reconciliation to the approved staging project. PREPARED, NOT EXECUTED.
// A complete transactional DRY RUN (apply, verify, real-role probes, ROLLBACK, then proof that staging is unchanged) always comes first; only with
// --live and the exact phrase is the real application committed (migration + history row atomically). Prints names and counts only.
//
// Gates: exact repo / branch (ui/stitch-mobile-redesign) / origin, clean tree, HEAD == --expected-head and a descendant of the certified baseline;
// approved staging ref only and the production ref absent; verified TLS; existing encrypted backups AND the fresh backup (< 6 h, outside the repo,
// same Auth-user count) authenticate; hosted history is exactly 92 migrations ending 20261116000001; the hosted pre-state matches the frozen
// observation exactly; the migration matches its frozen SHA-256 (LF-normalised) and consists only of allow-listed statements.
//
//   node --env-file=.env.local scripts/staging/apply-bay-board-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-bay-board-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATION = { version: "20261117000001", name: "bay_board_sec016_reconciliation", sha256: "a740c9780274a67573570a5834af3f70459d20db0a4abc7eb477c25cb388c725" };
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The certified baseline (dashboard/role-workspaces-adjustment); HEAD must descend from it. */
export const CERTIFIED_BASE = "ac91dd59a6ab066a48553084d2dc8b2942e8deb9";
export const PRE_COUNT = 92;
export const LAST_PRE = "20261116000001";
export const LIVE_PHRASE = `APPLY ${MIGRATION.version} TO STAGING ${APPROVED_REF}`;
/**
 * Exact hosted pre-state, frozen from a read-only observation of the approved staging project on 2026-10-20 (information_schema / pg_catalog only).
 * Any difference aborts the run before anything is written: the migration was reviewed against exactly this state.
 */
export const PRE_STATE = {
  functionMd5: "65028798b594260183b0ef487f152a77", // md5(pg_get_functiondef('public.get_bay_board_secure(text,text)'))
  functionAcl: "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  bayBoardColumnsMd5: "2e88a9298553f224f2ebe381153726db", // information_schema.columns of public.bay_board, ordered
  sec016Columns: 61,
  sec016ColumnsMd5: "9658cb2c7021205fb3a190e6e48af242",
  indexesMd5: "d6d86e894c8d53720294e5e16d2293a7", // pg_indexes of bay_board + report_sec016
};

const NEW_BAY_COLUMNS = ["flight", "is_manual", "arrival_report_id", "departure_report_id"];
const NEW_SEC016_COLUMNS = ["flight_type", "aircraft_search_completed", "search_overdue_flag", "search_remark"];
const AUTHORIZED = ["operation_manager", "main_enforcement", "maa_boss", "maa_admin", "aax_boss", "aax_admin"];
const DENIED = ["aso", "aso-kul", "sso", "so", "ghod", "global_reporting_controller", "airasia_management", "super_admin", "compliance", "caterlink_management", "caterlink-driver", "caterlink-vendor", "neg-pending-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment"];
const WRITER = "aso";
const RPC_COLUMNS = "id,station,reg_no,aircraft_type,bay,flight,on_ground_since";

export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

/** Statements the migration may contain (comments and $function$ bodies removed). Anything else aborts the run. */
const ALLOWED_STATEMENTS = [
  /^alter table public\.report_sec016\s+add column if not exists flight_type text not null default 'arrival' check \(flight_type in \('arrival', 'departure'\)\),\s+add column if not exists aircraft_search_completed boolean not null default false,\s+add column if not exists search_overdue_flag boolean not null default false,\s+add column if not exists search_remark text$/i,
  /^create index if not exists idx_report_sec016_flight_type on public\.report_sec016 \(flight_type\)$/i,
  /^create index if not exists idx_report_sec016_station_reg on public\.report_sec016 \(station, reg_no\)$/i,
  /^alter table public\.bay_board drop constraint if exists bay_board_cleared_by_report_id_fkey$/i,
  /^alter table public\.bay_board\s+add column if not exists flight text,\s+add column if not exists is_manual boolean not null default false,\s+add column if not exists arrival_report_id uuid references public\.report_sec016\(id\),\s+add column if not exists departure_report_id uuid references public\.report_sec016\(id\)$/i,
  /^create index if not exists idx_bay_board_match on public\.bay_board \(station, reg_no, cleared_at\)$/i,
  /^create index if not exists idx_bay_board_arrival_report on public\.bay_board \(arrival_report_id\)$/i,
  /^create or replace function public\.get_bay_board_secure\(p_hub_code text default null, p_station_code text default null\)\s+returns table \(id uuid, station text, reg_no text, aircraft_type text, bay text, flight text, on_ground_since timestamptz\)\s+language plpgsql\s+stable\s+security definer\s+set search_path to 'public'\s+as ''$/i,
  /^revoke execute on function public\.get_bay_board_secure\(text, text\) from public, anon$/i,
  /^grant execute on function public\.get_bay_board_secure\(text, text\) to authenticated, service_role$/i,
];

/** Returns the first statement of a migration that is not on the allow-list, or null. */
export function statementAudit(sql) {
  const code = String(sql).replace(/--.*$/gm, "").replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
  const bad = statements.find((s) => !ALLOWED_STATEMENTS.some((rx) => rx.test(s)));
  return bad ? bad.slice(0, 120) : null;
}

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const LIVE = args.includes("--live");
const fail = (m) => { throw new Error(m); };

/**
 * Git gates of the run: exact repository, branch RUNNER_BRANCH, origin, clean working tree, HEAD === the expected head (and, when it differs,
 * a descendant of it with only tooling changed) and a descendant of the certified baseline. Exported so tests exercise the real gate code.
 */
export function runnerGitGates({ expectedHead, repoPath, certifiedBase = CERTIFIED_BASE }) {
  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: repoPath, expectedBranch: RUNNER_BRANCH });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  try { child_process.execSync(`git merge-base --is-ancestor ${certifiedBase} HEAD`, { stdio: "ignore" }); } catch { fail("HEAD does not descend from the certified baseline"); }
  return git;
}

/** The migration file must match its frozen SHA-256 (LF-normalised) and contain only allow-listed statements. Returns the SQL text. */
export function verifyFrozenMigration(buf, file = `${MIGRATION.version}_${MIGRATION.name}.sql`) {
  const sha = normalisedSha256(buf);
  if (sha !== MIGRATION.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${MIGRATION.sha256}`);
  const text = buf.toString("utf8");
  const bad = statementAudit(text);
  if (bad) fail(`${file} contains a statement outside the reviewed allow-list: ${bad}`);
  return text;
}
const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `bay-board-${process.pid}.log`), l + "\n"); };

/** md5 fingerprints of everything the migration must NOT change, plus the two tables it does change (counts only). */
async function fingerprint(q) {
  return {
    otherFunctions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname <> 'get_bay_board_secure' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    policies: (await q("select md5(string_agg(schemaname || tablename || policyname || cmd || permissive || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    otherTables: (await q("select md5(string_agg(table_name || column_name || data_type || is_nullable || coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public' and table_name not in ('bay_board','report_sec016')"))[0].h,
    tableGrants: (await q("select coalesce(md5(string_agg(table_name || grantee || privilege_type, ',' order by table_name, grantee, privilege_type)), 'none') h from information_schema.role_table_grants where table_schema = 'public' and table_name in ('bay_board','report_sec016')"))[0].h,
    profiles: (await q("select coalesce(md5(string_agg(md5(p::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    history: (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h,
    bayRows: (await q("select count(*)::text h from public.bay_board"))[0].h,
    sec016Rows: (await q("select count(*)::text h from public.report_sec016"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
  };
}

const cols = (q, table) => q("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table]).then((r) => r.map((c) => c.column_name));

/** Verifies the hosted pre-state. `hashes` (the frozen staging observation) is null only in the local verifier. */
async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1].version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  const bay = await cols(q, "bay_board");
  const sec = await cols(q, "report_sec016");
  if (NEW_BAY_COLUMNS.some((c) => bay.includes(c))) fail("bay_board already has one of the columns this migration adds");
  if (NEW_SEC016_COLUMNS.some((c) => sec.includes(c))) fail("report_sec016 already has one of the columns this migration adds");
  const fk = await q("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'bay_board_cleared_by_report_id_fkey' and conrelid = 'public.bay_board'::regclass");
  if (fk.length !== 1 || !/REFERENCES report_sec029\(id\)|REFERENCES public\.report_sec029\(id\)/.test(fk[0].d)) fail("the legacy bay_board -> report_sec029 foreign key is not present as observed");
  if ((await q("select count(*)::int n from public.report_sec016"))[0].n !== 0) fail("report_sec016 holds rows: the canonical flight_type default ('arrival') would be assigned to existing data; an owner decision is required");
  if ((await q("select relrowsecurity r from pg_class where oid = 'public.bay_board'::regclass"))[0].r !== true) fail("row level security is not enabled on bay_board");
  if (ctx.hashes) {
    const h = ctx.hashes;
    const md = async (sql) => (await q(sql))[0].h;
    const colMd5 = (t) => `select md5(string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), ',' order by ordinal_position)) h from information_schema.columns where table_schema='public' and table_name='${t}'`;
    if ((await md("select md5(pg_get_functiondef('public.get_bay_board_secure(text,text)'::regprocedure)) h")) !== h.functionMd5) fail("get_bay_board_secure differs from the observed pre-state");
    if ((await md("select proacl::text h from pg_proc where oid = 'public.get_bay_board_secure(text,text)'::regprocedure")) !== h.functionAcl) fail("get_bay_board_secure ACL differs from the observed pre-state");
    if ((await md(colMd5("bay_board"))) !== h.bayBoardColumnsMd5) fail("bay_board columns differ from the observed pre-state");
    if ((await md(colMd5("report_sec016"))) !== h.sec016ColumnsMd5 || sec.length !== h.sec016Columns) fail("report_sec016 columns differ from the observed pre-state");
    if ((await md("select md5(string_agg(indexname||indexdef, ',' order by indexname)) h from pg_indexes where schemaname='public' and tablename in ('bay_board','report_sec016')")) !== h.indexesMd5) fail("bay_board / report_sec016 indexes differ from the observed pre-state");
  }
}

/**
 * The whole rollout as one unit: verify pre-state, snapshot fingerprints, dry run (apply + checks + probes + ROLLBACK), prove nothing changed, and
 * only if ctx.live commit a second, identical pass. Exported so the local verifier can run the identical code against disposable PostgreSQL.
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, writer?, onSnapshot? }
 */
export async function execute(client, ctx) {
  const { files, acct, log } = ctx;
  const q = async (s, p) => (await client.query(s, p)).rows;
  const probes = [];
  const probe = (name) => { probes.push(name); log(`PROBE PASS: ${name}`); };

  await verifyPreState(q, ctx);
  log("hosted pre-state verified exactly (history, columns, indexes, legacy FK, function body and ACL, RLS, zero SEC016 rows)");
  const pre = await fingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    functionDefinition: (await q("select pg_get_functiondef('public.get_bay_board_secure(text,text)'::regprocedure) d"))[0].d,
    bayBoardColumns: await q("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='bay_board' order by ordinal_position"),
    constraints: await q("select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.bay_board'::regclass, 'public.report_sec016'::regclass) order by conname"),
    indexes: await q("select indexname, indexdef from pg_indexes where schemaname='public' and tablename in ('bay_board','report_sec016') order by indexname"),
    fingerprints: pre,
  };
  if (ctx.onSnapshot) await ctx.onSnapshot(snapshot);

  const asRole = async (uid, role, fn) => {
    await client.query("SAVEPOINT pr");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
      return await fn();
    } catch (e) { return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 90)}`; } finally { await client.query("ROLLBACK TO SAVEPOINT pr"); }
  };
  const asUser = (label, fn) => asRole(acct(label), "authenticated", fn);
  const rpcRows = async (sql, params) => (await client.query(sql, params)).rows;

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== ctx.preCount + files.length) fail("unexpected history count");

      // ---- structure equals the canonical definition
      const bay = await cols(q, "bay_board");
      const sec = await cols(q, "report_sec016");
      if (!NEW_BAY_COLUMNS.every((c) => bay.includes(c)) || !NEW_SEC016_COLUMNS.every((c) => sec.includes(c))) fail("a column is missing after the migration");
      const shape = await q("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and ((table_name='bay_board' and column_name = any($1)) or (table_name='report_sec016' and column_name = any($2)))", [NEW_BAY_COLUMNS, NEW_SEC016_COLUMNS]);
      const c = (n) => shape.find((x) => x.column_name === n);
      if (c("flight").data_type !== "text" || c("flight").is_nullable !== "YES" || c("is_manual").data_type !== "boolean" || c("is_manual").is_nullable !== "NO" || !/false/.test(c("is_manual").column_default)
        || c("arrival_report_id").data_type !== "uuid" || c("departure_report_id").data_type !== "uuid" || c("flight_type").is_nullable !== "NO" || !/arrival/.test(c("flight_type").column_default)
        || c("aircraft_search_completed").data_type !== "boolean" || c("search_overdue_flag").data_type !== "boolean" || c("search_remark").data_type !== "text") fail("a new column does not match its canonical definition");
      if ((await q("select count(*)::int n from pg_constraint where conname = 'bay_board_cleared_by_report_id_fkey' and conrelid = 'public.bay_board'::regclass"))[0].n !== 0) fail("the legacy FK is still present");
      if ((await q("select count(*)::int n from pg_constraint where conrelid = 'public.bay_board'::regclass and contype = 'f' and confrelid = 'public.report_sec016'::regclass"))[0].n !== 2) fail("arrival/departure report FKs are not exactly two");
      if ((await q("select count(*)::int n from pg_indexes where schemaname='public' and indexname in ('idx_report_sec016_flight_type','idx_report_sec016_station_reg','idx_bay_board_match','idx_bay_board_arrival_report')"))[0].n !== 4) fail("canonical indexes missing");
      // ---- function: same hardening, same ACL, owner unchanged
      const fn = (await q("select p.prosecdef sd, p.provolatile vol, coalesce(p.proconfig::text,'') cfg, p.proowner = c.relowner same_owner, coalesce(p.proacl::text,'') acl from pg_proc p, pg_class c where p.oid = 'public.get_bay_board_secure(text,text)'::regprocedure and c.oid = 'public.bay_board'::regclass"))[0];
      if (!fn.sd || fn.vol !== "s" || !/search_path=public/.test(fn.cfg) || !fn.same_owner) fail("get_bay_board_secure is not SECURITY DEFINER / STABLE / fixed search_path / table-owner-owned");
      const g = (await q("select has_function_privilege('anon', 'public.get_bay_board_secure(text,text)', 'execute') an, has_function_privilege('authenticated', 'public.get_bay_board_secure(text,text)', 'execute') au, has_function_privilege('service_role', 'public.get_bay_board_secure(text,text)', 'execute') sv"))[0];
      if (g.an || !g.au || !g.sv || /(^\{|,)=/.test(fn.acl)) fail("get_bay_board_secure execute grants are not anon/PUBLIC-denied and authenticated + service_role-granted");
      if ((await q("select count(*)::int n from information_schema.role_table_grants where table_schema='public' and table_name in ('bay_board','report_sec016') and grantee in ('anon','PUBLIC')"))[0].n !== 0) fail("an anon / PUBLIC table grant exists");
      const mid = await fingerprint(q);
      for (const k of ["otherFunctions", "policies", "otherTables", "tableGrants", "profiles", "assignments", "authUsers", "bayRows", "sec016Rows"]) if (mid[k] !== pre[k]) fail(`the migration changed something it must not (${k})`);
      log("structure, function hardening, grants, policies and every unrelated fingerprint are as designed inside the transaction");

      // ---- real-role probes (everything below is rolled back with the transaction)
      for (const label of AUTHORIZED) {
        const r = await asUser(label, async () => { const res = await client.query("select * from public.get_bay_board_secure(null, null)"); return { cols: res.fields.map((f) => f.name).join(), n: res.rowCount }; });
        if (typeof r === "string" || r.cols !== RPC_COLUMNS) fail(`${label} cannot read the Bay Board (${typeof r === "string" ? r : r.cols})`);
        probe(`${label}: reads the Bay Board through get_bay_board_secure (${r.n} open aircraft, unchanged column list)`);
      }
      for (const label of DENIED) {
        try { acct(label); } catch { log(`SKIP probe for ${label}: not in the review manifest`); continue; }
        const r = await asUser(label, async () => { await client.query("select * from public.get_bay_board_secure(null, null)"); return "ALLOWED"; });
        if (r === "ALLOWED" || !/Only an approved entity leader|permission denied/i.test(r)) fail(`${label} was not refused by get_bay_board_secure (${r})`);
        probe(`${label}: refused by get_bay_board_secure`);
      }
      const anon = await asRole(null, "anon", async () => { await client.query("select * from public.get_bay_board_secure(null, null)"); return "ALLOWED"; });
      if (anon === "ALLOWED" || !/permission denied/i.test(anon)) fail(`anon was not refused (${anon})`);
      probe("anon: refused by get_bay_board_secure (execute revoked)");
      const injected = await asUser("operation_manager", async () => (await client.query("select * from public.get_bay_board_secure($1, $2)", ["x' or '1'='1", "KUL - MAA'; drop table public.bay_board; --"])).rowCount);
      if (injected !== 0) fail(`injection-like filter text did not return an empty result (${injected})`);
      probe("injection-like filter text returns nothing and harms nothing");
      const anonWrite = await asRole(null, "anon", async () => { await client.query("insert into public.bay_board (station, reg_no, bay, on_ground_since, created_by) values ('PEN', 'X', 'X', now(), $1)", [acct(WRITER)]); return "ALLOWED"; });
      if (anonWrite === "ALLOWED" || !/permission denied|row-level security/i.test(anonWrite)) fail(`anon could write bay_board (${anonWrite})`);
      probe("anon: cannot write bay_board");

      // reachable write workflow, as the real station user under RLS: SEC016 arrival -> Bay Board -> SEC016 departure clears it; manual entry and clear
      const w = (await q("select id, station, team, name, staff_no from public.profiles where id = $1", [acct(WRITER)]))[0];
      if (!w?.station || !w?.team) fail(`${WRITER} has no station / team on its profile`);
      const writeFlow = await asUser(WRITER, async () => {
        const arr = crypto.randomUUID();
        await client.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies, flight_type, aircraft_search_completed, search_overdue_flag, search_remark)
          values ($1,$2,'submitted',$3,$4,$5,$6,current_date,'10:00','AK703','ARR','x','A320','9M-DRY','10:00','10:05','B1','NO','sl','YES','YES','none','arrival',false,false,null)`, [arr, w.id, w.station, w.team, w.name ?? "dry run", w.staff_no ?? "DRY"]);
        await client.query("insert into public.bay_board (station, reg_no, aircraft_type, bay, flight, arrival_report_id, on_ground_since, is_manual, created_by) values ($1,'9M-DRY','A320','B1','AK703',$2, now(), false, $3)", [w.station, arr, w.id]);
        const seen = (await client.query("select count(*)::int n from public.bay_board where reg_no = '9M-DRY' and flight = 'AK703' and cleared_at is null")).rows[0].n;
        const dep = crypto.randomUUID();
        await client.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies, flight_type, aircraft_search_completed, search_overdue_flag, search_remark)
          values ($1,$2,'submitted',$3,$4,$5,$6,current_date,'10:00','AK703','DEP','x','A320','9M-DRY','10:00','10:05','B1','NO','sl','YES','YES','none','departure',false,false,null)`, [dep, w.id, w.station, w.team, w.name ?? "dry run", w.staff_no ?? "DRY"]);
        const cleared = (await client.query("update public.bay_board set cleared_at = now(), cleared_by_report_id = $1, departure_report_id = $1 where station = $2 and reg_no = '9M-DRY' and cleared_at is null", [dep, w.station])).rowCount;
        await client.query("insert into public.bay_board (station, reg_no, aircraft_type, bay, flight, on_ground_since, is_manual, created_by) values ($1,'9M-DRM','A320','B2','AK1', now(), true, $2)", [w.station, w.id]);
        const manualCleared = (await client.query("update public.bay_board set cleared_at = now() where reg_no = '9M-DRM' and cleared_at is null")).rowCount;
        return `${seen}|${cleared}|${manualCleared}`;
      });
      if (writeFlow !== "1|1|1") fail(`the SEC016 -> Bay Board write workflow failed (${writeFlow})`);
      probe(`${WRITER}: SEC016 arrival submit, Bay Board insert (flight, arrival_report_id, is_manual), SEC016 departure clear (SEC016 id in cleared_by_report_id, departure_report_id), manual entry and manual clear all succeed under RLS`);
      // a freshly written row is visible to leadership and carries its flight
      const lead = await asUser(WRITER, async () => {
        await client.query("insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies, flight_type) select gen_random_uuid(), id, 'submitted', station, team, name, staff_no, current_date, '10:00', 'AK703', 'ARR', 'x', 'A320', '9M-DRV', '10:00', '10:05', 'B1', 'NO', 'sl', 'YES', 'YES', 'none', 'arrival' from public.profiles where id = $1", [w.id]);
        await client.query("insert into public.bay_board (station, reg_no, aircraft_type, bay, flight, on_ground_since, is_manual, created_by) values ($1,'9M-DRV','A320','B3','AK703', now(), false, $2)", [w.station, w.id]);
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: acct("operation_manager"), role: "authenticated" })]);
        return (await client.query("select flight from public.get_bay_board_secure(null, $1) where reg_no = '9M-DRV'", [w.station])).rows.map((r) => r.flight).join();
      });
      if (lead !== "AK703") fail(`leadership did not see the written row with its flight (${lead})`);
      probe("leadership read round-trip: a row written by the station user is returned by get_bay_board_secure with its flight value");

      if (real) {
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  await pass(false);
  log("dry run rolled back");
  await verifyPreState(q, ctx);
  const afterDry = await fingerprint(q);
  for (const k of Object.keys(pre)) if (afterDry[k] !== pre[k]) fail(`staging changed after the rolled-back dry run (${k})`);
  log("staging is unchanged after the dry-run rollback (history, columns, indexes, function, policies, grants, every fingerprint)");
  let committed = false;
  if (ctx.live) {
    await pass(true);
    committed = true;
    const post = await fingerprint(q);
    for (const k of ["otherFunctions", "policies", "otherTables", "tableGrants", "profiles", "assignments", "authUsers", "bayRows", "sec016Rows"]) if (post[k] !== pre[k]) fail(`after the live apply an unrelated fingerprint changed (${k})`);
    const cnt = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
    if (cnt.n !== ctx.preCount + files.length || cnt.v !== files[files.length - 1].version) fail("post-apply history is not as expected");
    log(`LIVE: migration committed and verified (history ${cnt.n} ending ${cnt.v})`);
  }
  return { probes, committed, snapshot };
}

async function main() {
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  const log = defaultLog;
  log(`bay board migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

  const git = runnerGitGates({ expectedHead, repoPath: path.resolve(import.meta.dirname, "../..") });
  log(`HEAD=${git.head.slice(0, 12)}; branch ${RUNNER_BRANCH}, origin and certified-baseline ancestry verified; working tree clean`);
  environmentGates();
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("production reference present");
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(freshBackup)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  const file = `${MIGRATION.version}_${MIGRATION.name}.sql`;
  const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
  const text = verifyFrozenMigration(buf, file);
  const migDir = fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  if (migDir.filter((f) => f.slice(0, 14) > LAST_PRE).join() !== file) fail("the repository holds a migration after the last applied one that is not the frozen one");
  log(`${file} matches its frozen SHA-256, contains only allow-listed statements and is the only migration after ${LAST_PRE}`);

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    if ((await client.query("select count(*)::int n from auth.users")).rows[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    const result = await execute(client, {
      files: [{ ...MIGRATION, file, sql: text }], acct, live: LIVE, log, preCount: PRE_COUNT, lastPre: LAST_PRE, hashes: PRE_STATE,
      onSnapshot: async (snapshot) => {
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-bay-board-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (function definition, bay_board columns, constraints, indexes, fingerprints) written and re-authenticated (${path.basename(snap)})`);
      },
    });
    log(`${LIVE ? "LIVE APPLY COMPLETE" : "DRY RUN COMPLETE: nothing was changed"}; ${result.probes.length} probes passed`);
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`FAILED: ${String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`); process.exit(1); });
}
