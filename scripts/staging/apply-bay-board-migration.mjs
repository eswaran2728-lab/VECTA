#!/usr/bin/env node
// Applies ONLY the frozen forward migration 20261117000001_bay_board_sec016_reconciliation (Bay Board + SEC016 reconciliation incl. the Rev.03 columns and
// the sixteen relaxed legacy columns) to the approved staging project. PREPARED, NOT EXECUTED.
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
import * as F from "./lib/sec016-fixtures.mjs";

export const MIGRATION = { version: "20261117000001", name: "bay_board_sec016_reconciliation", sha256: "bfdb30cf474bc6ba65732786fb9ad1a2692fc9e386afa1f14da5e76fe643d27b" };
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
  // Added after the hosted dry run of 2026-10-21 exposed the Rev.03 drift; frozen from a read-only observation of the same project (names/definitions only).
  constraintsMd5: "82e4e69f661beb37625dc45c3bfdaaa0", // non-NOT-NULL constraints of bay_board + report_sec016
  policiesMd5: "8e9b470bc98c958e1bdfc8748a8c5f66", // pg_policies of bay_board + report_sec016
  tableGrantsMd5: "71ec0d07d850ad7daecf70ea3903d661", // role_table_grants of bay_board + report_sec016
  triggersMd5: "317413b417494bd314e4a03e3e675edf", // non-internal triggers of bay_board + report_sec016
  legacyNotNull: F.SEC016_LEGACY_NULLABLE.slice().sort().join(","), // the sixteen legacy columns that are still NOT NULL on hosted
  absentColumns: Object.keys(F.SEC016_NEW_COLUMNS).sort().join(","), // the eight report_sec016 columns hosted lacks
};

/** Probes the dry run must complete on the hosted database (every role in the review manifest present). The run is refused if fewer or more were executed. */
export const EXPECTED_PROBES = 34;
export const DENIED_LABELS = ["aso", "aso-kul", "sso", "so", "ghod", "global_reporting_controller", "airasia_management", "super_admin", "compliance", "caterlink_management", "caterlink-driver", "caterlink-vendor", "neg-pending-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment"];

const NEW_BAY_COLUMNS = ["flight", "is_manual", "arrival_report_id", "departure_report_id"];
const NEW_SEC016_COLUMNS = Object.keys(F.SEC016_NEW_COLUMNS);
const AUTHORIZED = ["operation_manager", "main_enforcement", "maa_boss", "maa_admin", "aax_boss", "aax_admin"];
const DENIED = DENIED_LABELS;
const WRITER = "aso";
const RPC_COLUMNS = "id,station,reg_no,aircraft_type,bay,flight,on_ground_since";

export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

/** Statements the migration may contain (comments and $function$ bodies removed). Anything else aborts the run. */
const ALLOWED_STATEMENTS = [
  /^alter table public\.report_sec016\s+add column if not exists flight_type text not null default 'arrival' check \(flight_type in \('arrival', 'departure'\)\),\s+add column if not exists aircraft_search_completed boolean not null default false,\s+add column if not exists search_overdue_flag boolean not null default false,\s+add column if not exists search_remark text$/i,
  // 20260914000001 (Rev.03 direction fields), the historical ops_group the application still writes, and the sixteen relaxed legacy columns (exactly these, in the canonical order)
  /^alter table public\.report_sec016\s+add column if not exists ramp_agents_baggage text,\s+add column if not exists ramp_agents_cargo text,\s+add column if not exists cabin_check text$/i,
  /^alter table public\.report_sec016 add column if not exists ops_group text$/i,
  new RegExp(`^alter table public\\.report_sec016\\s+${F.SEC016_LEGACY_NULLABLE.map((c) => `alter column ${c} drop not null`).join(",\\s+")}$`, "i"),
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
  if ((await q("select count(*)::int n from public.bay_board"))[0].n !== 0) fail("bay_board holds rows: the reviewed pre-state has none");
  // the sixteen legacy columns are exactly the NOT NULL ones the migration relaxes (and no other legacy column is in a different state)
  const stillNotNull = (await q("select column_name from information_schema.columns where table_schema='public' and table_name='report_sec016' and is_nullable='NO' and column_name = any($1) order by column_name", [F.SEC016_LEGACY_NULLABLE])).map((r) => r.column_name);
  if (stillNotNull.join(",") !== F.SEC016_LEGACY_NULLABLE.slice().sort().join(",")) fail(`the sixteen legacy report_sec016 columns are not all NOT NULL as observed (${stillNotNull.length} of 16)`);
  if ((await q("select relrowsecurity r from pg_class where oid = 'public.bay_board'::regclass"))[0].r !== true) fail("row level security is not enabled on bay_board");
  if (ctx.hashes) {
    const h = ctx.hashes;
    const md = async (sql) => (await q(sql))[0].h;
    const colMd5 = (t) => `select md5(string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), ',' order by ordinal_position)) h from information_schema.columns where table_schema='public' and table_name='${t}'`;
    if ((await md("select md5(pg_get_functiondef('public.get_bay_board_secure(text,text)'::regprocedure)) h")) !== h.functionMd5) fail("get_bay_board_secure differs from the observed pre-state");
    if ((await md("select proacl::text h from pg_proc where oid = 'public.get_bay_board_secure(text,text)'::regprocedure")) !== h.functionAcl) fail("get_bay_board_secure ACL differs from the observed pre-state");
    if ((await md(colMd5("bay_board"))) !== h.bayBoardColumnsMd5) fail("bay_board columns differ from the observed pre-state");
    if ((await md(colMd5("report_sec016"))) !== h.sec016ColumnsMd5 || sec.length !== h.sec016Columns) fail("report_sec016 columns differ from the observed pre-state");
    if (h.legacyNotNull !== F.SEC016_LEGACY_NULLABLE.slice().sort().join(",") || h.absentColumns !== NEW_SEC016_COLUMNS.slice().sort().join(",")) fail("the frozen legacy / absent column lists differ from the migration's definitions");
    const T = "'public.bay_board'::regclass,'public.report_sec016'::regclass";
    if ((await md(`select md5(string_agg(c.relname||':'||k.conname||':'||pg_get_constraintdef(k.oid), ',' order by c.relname,k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.oid in (${T}) and k.contype <> 'n'`)) !== h.constraintsMd5) fail("bay_board / report_sec016 constraints differ from the observed pre-state");
    if ((await md("select md5(string_agg(tablename||':'||policyname||':'||cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,''), ',' order by tablename,policyname)) h from pg_policies where schemaname='public' and tablename in ('bay_board','report_sec016')")) !== h.policiesMd5) fail("bay_board / report_sec016 policies differ from the observed pre-state");
    if ((await md("select md5(string_agg(table_name||':'||grantee||':'||privilege_type, ',' order by table_name,grantee,privilege_type)) h from information_schema.role_table_grants where table_schema='public' and table_name in ('bay_board','report_sec016')")) !== h.tableGrantsMd5) fail("bay_board / report_sec016 table grants differ from the observed pre-state");
    if ((await md(`select md5(string_agg(c.relname||':'||t.tgname||':'||pg_get_triggerdef(t.oid), ',' order by c.relname,t.tgname)) h from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid in (${T}) and not t.tgisinternal`)) !== h.triggersMd5) fail("bay_board / report_sec016 triggers differ from the observed pre-state");
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
    const colShape = (t) => q("select column_name, data_type, is_nullable, coalesce(column_default,'') as d from information_schema.columns where table_schema='public' and table_name=$1 order by column_name", [t]);
    const trgMd5 = async () => (await q("select md5(string_agg(c.relname||':'||t.tgname||':'||pg_get_triggerdef(t.oid), ',' order by c.relname,t.tgname)) h from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid in ('public.bay_board'::regclass,'public.report_sec016'::regclass) and not t.tgisinternal"))[0].h;
    const secBefore = await colShape("report_sec016");
    const bayBefore = await colShape("bay_board");
    const triggersBefore = await trgMd5();
    try {
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      // ---- history: exactly one new row for exactly this version
      const hist = (await q("select count(*)::int n, (count(*) filter (where version = $1))::int m, max(version) v from supabase_migrations.schema_migrations", [files[0].version]))[0];
      if (hist.n !== ctx.preCount + files.length || hist.m !== 1 || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} with ${files[0].version} recorded exactly once (${hist.n} / ${hist.m} / ${hist.v})`);
      log(`migration history is ${hist.n} with ${files[0].version} recorded exactly once`);

      // ---- structure equals the canonical definition, and NOTHING ELSE changed in the two tables
      const secAfter = await colShape("report_sec016");
      const bayAfter = await colShape("bay_board");
      const diffCols = (b, a) => {
        const bm = new Map(b.map((x) => [x.column_name, x])); const am = new Map(a.map((x) => [x.column_name, x]));
        const changed = [...am.keys()].filter((k) => bm.has(k) && JSON.stringify(bm.get(k)) !== JSON.stringify(am.get(k))).sort();
        return {
          added: [...am.keys()].filter((k) => !bm.has(k)).sort(), removed: [...bm.keys()].filter((k) => !am.has(k)).sort(), changed,
          onlyNullability: changed.every((k) => bm.get(k).data_type === am.get(k).data_type && bm.get(k).d === am.get(k).d && bm.get(k).is_nullable === "NO" && am.get(k).is_nullable === "YES"),
        };
      };
      const sd = diffCols(secBefore, secAfter); const bd = diffCols(bayBefore, bayAfter);
      if (sd.added.join() !== Object.keys(F.SEC016_NEW_COLUMNS).sort().join() || sd.removed.length || sd.changed.join() !== F.SEC016_LEGACY_NULLABLE.slice().sort().join() || !sd.onlyNullability) fail(`report_sec016 changed other than designed (added ${sd.added.join()}; removed ${sd.removed.join()}; changed ${sd.changed.length})`);
      if (bd.added.join() !== Object.keys(F.BAY_NEW_COLUMNS).sort().join() || bd.removed.length || bd.changed.length) fail(`bay_board changed other than designed (added ${bd.added.join()}; removed ${bd.removed.join()}; changed ${bd.changed.join()})`);
      log("no unrelated column change: report_sec016 gained exactly eight columns and relaxed exactly the sixteen legacy NOT NULL constraints (nothing else changed); bay_board gained exactly four columns");
      const defOk = (rows, defs, t) => { for (const [col, d] of Object.entries(defs)) { const r = rows.find((x) => x.column_name === col); if (!r || r.data_type !== d.data_type || r.is_nullable !== d.nullable || (d.default ? !d.default.test(r.d) : r.d !== "")) fail(`${t}.${col} does not match its canonical definition`); } };
      defOk(secAfter, F.SEC016_NEW_COLUMNS, "report_sec016"); defOk(bayAfter, F.BAY_NEW_COLUMNS, "bay_board");
      if (secAfter.some((x) => x.column_name === "org_id") || bayAfter.some((x) => x.column_name === "org_id")) fail("an org_id column appeared");
      if ((await q("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='report_sec016' and is_nullable='NO' and column_name = any($1)", [F.SEC016_LEGACY_NULLABLE]))[0].n !== 0) fail("a legacy report_sec016 column is still NOT NULL");
      if ((await q("select count(*)::int n from pg_constraint where conrelid = 'public.report_sec016'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'flight_type'"))[0].n !== 1) fail("the flight_type check constraint is not present exactly once");
      log("all eight report_sec016 columns (flight_type, aircraft_search_completed, search_overdue_flag, search_remark, ramp_agents_baggage, ramp_agents_cargo, cabin_check, ops_group) and the four bay_board columns match their canonical definitions; all sixteen legacy columns are nullable");
      if ((await q("select count(*)::int n from pg_constraint where conname = 'bay_board_cleared_by_report_id_fkey' and conrelid = 'public.bay_board'::regclass"))[0].n !== 0) fail("the legacy FK is still present");
      if ((await q("select count(*)::int n from pg_constraint where conrelid = 'public.bay_board'::regclass and contype = 'f' and confrelid = 'public.report_sec016'::regclass"))[0].n !== 2) fail("arrival/departure report FKs are not exactly two");
      if ((await q("select count(*)::int n from pg_indexes where schemaname='public' and indexname in ('idx_report_sec016_flight_type','idx_report_sec016_station_reg','idx_bay_board_match','idx_bay_board_arrival_report')"))[0].n !== 4) fail("canonical indexes missing");
      if ((await trgMd5()) !== triggersBefore) fail("a trigger on bay_board / report_sec016 changed");
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

      // ---- the application's OWN statements (names and order proven equal to lib/avsec/reports/actions.ts by tests/sec016-app-payload.test.mts), as real roles under RLS
      const w = (await q("select id, station, team, name, staff_no from public.profiles where id = $1", [acct(WRITER)]))[0];
      if (!w?.station || !w?.team) fail(`${WRITER} has no station / team on its profile`);
      const OTHER = ctx.other ?? "aso-jhb";
      const exact = (flightType, reg, over = {}) => F.sec016AppPayload({ profileId: w.id, station: w.station, team: w.team, name: w.name ?? "dry run", staffNo: w.staff_no ?? "DRY", reg, flight: "AK703", flightType, ...over });
      const SUBMIT_RETURNING = "id, ramp_agents_baggage, ramp_agents_cargo, cabin_check, ops_group, flight_type, inbound_baggage, outbound_baggage, ramp_staff_1, ramp_staff_2, ramp_staff_3, ramp_staff_4, ramp_staff_5, offload_flight_no, offload_destination, offload_total_baggage";
      // the application returns only id, submitted_at, report_no (the only SELECT-granted columns); the stored values are then read back as the table owner
      const submit = async (payload) => {
        const ins = F.insertSql("report_sec016", payload);
        const id = (await client.query(`${ins.text} returning id, submitted_at, report_no`, ins.values)).rows[0].id;
        await client.query("reset role");
        try { return (await client.query(`select ${SUBMIT_RETURNING} from public.report_sec016 where id = $1`, [id])).rows[0]; }
        finally { await client.query("select set_config('role', 'authenticated', true)"); }
      };
      const bayInsert = (o) => { const i = F.insertSql("bay_board", o); return client.query(i.text, i.values); };
      const arrivalBay = (reg, reportId) => ({ station: w.station, reg_no: reg, aircraft_type: "A320", bay: "B1", flight: "AK703", arrival_report_id: reportId, on_ground_since: new Date().toISOString(), is_manual: false, created_by: w.id });
      const legacyNull = (r) => ["ramp_staff_1", "ramp_staff_2", "ramp_staff_3", "ramp_staff_4", "ramp_staff_5", "offload_flight_no", "offload_destination", "offload_total_baggage"].every((c) => r[c] === null);

      const arr = await asUser(WRITER, async () => { const r = await submit(exact("arrival", "9M-DRY")); return `${r.ramp_agents_baggage}|${r.ramp_agents_cargo}|${r.cabin_check}|${r.ops_group}|${r.flight_type}|${r.inbound_baggage}|${r.outbound_baggage}|${legacyNull(r)}`; });
      if (arr !== "RAMP-B1|RAMP-C1|YES|null|arrival|TRL-1|null|true") fail(`the canonical SEC016 arrival submission did not store the expected values (${arr})`);
      probe(`${WRITER}: SEC016 arrival submission (the application's exact 39-column insert) succeeds; the three rev03 direction fields are stored, ops_group is null, the direction's own fields are stored and every omitted legacy field is null`);
      const dep = await asUser(WRITER, async () => { const r = await submit(exact("departure", "9M-DRY2")); return `${r.ramp_agents_baggage}|${r.ramp_agents_cargo}|${r.cabin_check}|${r.flight_type}|${r.inbound_baggage}|${r.outbound_baggage}|${legacyNull(r)}`; });
      if (dep !== "RAMP-B1|RAMP-C1|YES|departure|null|TRL-2|true") fail(`the canonical SEC016 departure submission did not store the expected values (${dep})`);
      probe(`${WRITER}: SEC016 departure submission succeeds with the rev03 direction fields; the arrival-only fields stay null`);
      const legacy = await asUser(WRITER, async () => { const r = await submit(exact("arrival", "9M-DRY3", { withLegacyValues: true })); return `${r.ramp_staff_1}|${r.ramp_staff_2}|${r.offload_flight_no}|${r.offload_destination}|${r.offload_total_baggage}`; });
      if (legacy !== "RS1|RS2|AK1|KUL|3") fail(`explicit values in the relaxed legacy columns were not stored (${legacy})`);
      probe(`${WRITER}: explicit values in the relaxed legacy columns are still accepted and stored`);
      const ready = await asUser(WRITER, async () => { const r = await submit(exact("arrival", "9M-DRY4")); await client.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [r.id]); return "ready"; });
      if (ready !== "ready") fail(`SEC016 finalization (mark_report_ready_for_indexing) failed after a submission (${ready})`);
      probe(`${WRITER}: after a submission the indexing-readiness finalization the application calls (mark_report_ready_for_indexing) succeeds`);

      const writeFlow = await asUser(WRITER, async () => {
        const a = await submit(exact("arrival", "9M-DRYW"));
        await bayInsert(arrivalBay("9M-DRYW", a.id));
        const seen = (await client.query("select count(*)::int n from public.bay_board where reg_no = '9M-DRYW' and flight = 'AK703' and cleared_at is null")).rows[0].n;
        const d = await submit(exact("departure", "9M-DRYW"));
        const cleared = (await client.query("update public.bay_board set cleared_at = $1, cleared_by_report_id = $2, departure_report_id = $3 where station = $4 and reg_no = $5 and cleared_at is null", [new Date().toISOString(), d.id, d.id, w.station, "9M-DRYW"])).rowCount;
        await bayInsert({ station: w.station, reg_no: "9M-DRM", aircraft_type: "A320", bay: "B2", flight: "AK1", on_ground_since: new Date().toISOString(), is_manual: true, created_by: w.id });
        const manualCleared = (await client.query("update public.bay_board set cleared_at = $1 where reg_no = '9M-DRM' and cleared_at is null", [new Date().toISOString()])).rowCount;
        return `${seen}|${cleared}|${manualCleared}`;
      });
      if (writeFlow !== "1|1|1") fail(`the SEC016 -> Bay Board write workflow failed (${writeFlow})`);
      probe(`${WRITER}: SEC016 arrival submit, Bay Board arrival insert (flight, arrival_report_id, is_manual), SEC016 departure submit clearing it (SEC016 id in cleared_by_report_id and departure_report_id), manual entry and manual clear all succeed under RLS`);
      const lead = await asUser(WRITER, async () => {
        const r = await submit(exact("arrival", "9M-DRV"));
        await bayInsert(arrivalBay("9M-DRV", r.id));
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: acct("operation_manager"), role: "authenticated" })]);
        return (await client.query("select flight from public.get_bay_board_secure(null, $1) where reg_no = '9M-DRV'", [w.station])).rows.map((x) => x.flight).join();
      });
      if (lead !== "AK703") fail(`leadership did not see the written row with its flight (${lead})`);
      probe("leadership read round-trip: a row written by the station user is returned by get_bay_board_secure with its flight value");

      // ---- isolation of the new write path: another station's officer, a non-ASO officer and anonymous
      const isolation = await asUser(WRITER, async () => {
        const r = await submit(exact("arrival", "9M-ISO"));
        await bayInsert(arrivalBay("9M-ISO", r.id));
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: acct(OTHER), role: "authenticated" })]);
        const seen = (await client.query("select count(*)::int n from public.bay_board where reg_no = '9M-ISO'")).rows[0].n;
        const clear = (await client.query("update public.bay_board set cleared_at = now() where reg_no = '9M-ISO'")).rowCount;
        const sec = (await client.query("select count(*)::int n from public.report_sec016 where id = $1", [r.id])).rows[0].n; // id is SELECT-granted; RLS shows each officer only their own rows
        await client.query("SAVEPOINT iso");
        let ins = "ALLOWED";
        try { await bayInsert({ station: w.station, reg_no: "9M-ISO2", aircraft_type: "A320", bay: "B1", flight: "X", on_ground_since: new Date().toISOString(), is_manual: true, created_by: acct(OTHER) }); } catch (e) { ins = /row-level security|permission denied/i.test(e.message) ? "denied" : `ERR:${e.message.slice(0, 60)}`; }
        await client.query("ROLLBACK TO SAVEPOINT iso");
        return `${seen}|${clear}|${sec}|${ins}`;
      });
      if (isolation !== "0|0|0|denied") fail(`station isolation failed on the new write path (${isolation})`);
      probe(`${OTHER}: another station's officer sees 0 Bay Board rows and 0 SEC016 rows of ${WRITER}, clears 0, and cannot insert a Bay Board row for that station (RLS)`);
      const wrongRole = await asUser("operation_manager", async () => { const ins = F.insertSql("report_sec016", exact("arrival", "9M-WRONG", { profileId: acct("operation_manager") })); await client.query(ins.text, ins.values); return "ALLOWED"; });
      if (wrongRole === "ALLOWED" || !/row-level security|permission denied|violates|does not include the sec016 report form/i.test(wrongRole)) fail(`a non-ASO role could submit SEC016 (${wrongRole})`);
      probe("operation_manager: a non-ASO role cannot submit SEC016 (refused by the report-form assignment trigger / the own-insert policy that requires the aso role)");
      const anonSubmit = await asRole(null, "anon", async () => { const ins = F.insertSql("report_sec016", exact("arrival", "9M-ANON")); await client.query(ins.text, ins.values); return "ALLOWED"; });
      if (anonSubmit === "ALLOWED" || !/permission denied|row-level security/i.test(anonSubmit)) fail(`anon could submit SEC016 (${anonSubmit})`);
      probe("anon: cannot submit SEC016");

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
  if (ctx.expectedProbes !== undefined && probes.length !== ctx.expectedProbes) fail(`incomplete probe execution: ${probes.length} probes passed, ${ctx.expectedProbes} are required`);
  log(`all ${probes.length} required probes completed in the dry run`);
  await verifyPreState(q, ctx);
  const afterDry = await fingerprint(q);
  for (const k of Object.keys(pre)) if (afterDry[k] !== pre[k]) fail(`staging changed after the rolled-back dry run (${k})`);
  log("staging is unchanged after the dry-run rollback (history, columns, indexes, function, policies, grants, every fingerprint)");
  let committed = false;
  if (ctx.live) {
    await pass(true);
    committed = true;
    if (ctx.expectedProbes !== undefined && probes.length !== 2 * ctx.expectedProbes) fail("incomplete probe execution in the live pass");
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
      files: [{ ...MIGRATION, file, sql: text }], acct, live: LIVE, log, preCount: PRE_COUNT, lastPre: LAST_PRE, hashes: PRE_STATE, expectedProbes: EXPECTED_PROBES,
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
