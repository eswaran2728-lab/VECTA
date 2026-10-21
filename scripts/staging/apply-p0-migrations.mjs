#!/usr/bin/env node
// Applies ONLY the three frozen P0 compatibility migrations (20261118000001..3) to the approved staging project. PREPARED, NOT EXECUTED unless --live.
// A complete transactional DRY RUN (apply, verify, real-role probes, ROLLBACK, then proof that staging is unchanged) always comes first; only with
// --live and the exact phrase is a second, identical pass committed (all three migrations + their history rows in ONE transaction). Prints names and counts only.
//
// Gates: exact repo / branch (ui/stitch-mobile-redesign) / origin, clean tree, HEAD == --expected-head and a descendant of the pushed baseline;
// approved staging ref only and the production ref absent (including inherited environment); verified TLS; the existing and the fresh encrypted backups
// authenticate; hosted history is exactly 93 migrations ending 20261117000001; none of the three is recorded; the hosted pre-state matches the frozen
// observation exactly; each migration matches its frozen SHA-256 (LF-normalised) and consists only of allow-listed statements; the repository holds no
// other migration after the last applied one.
//
//   node --env-file=.env.local scripts/staging/apply-p0-migrations.mjs --expected-head=<sha> --backup=<fresh.enc.json>                      (dry run)
//   node --env-file=.env.local scripts/staging/apply-p0-migrations.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
//   node --env-file=.env.local scripts/staging/apply-p0-migrations.mjs --verify-applied                                                  (read-only post-apply check)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261118000001", name: "p0_report_schema_compatibility", sha256: "9c38f06d47071cea04cc80b9702761511709008670c91b90eef8defd6126e7df" },
  { version: "20261118000002", name: "p0_duty_overtime_compatibility", sha256: "40fd3d33a47b8241a374443787ea9682d34801c1aa21a6d6b181597c272e784d" },
  { version: "20261118000003", name: "p0_profile_approval_audit", sha256: "2a22a8f1b1f72bbe97d05b10c8e495c3aae9ab0c1b5ec2f74c887e9b43cc1357" },
];
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The pushed baseline the P0 commits sit on; HEAD must descend from it. */
export const PUSHED_BASE = "3a3eeb79883e5d37c2a44c87913fc5f696f83803";
export const PRE_COUNT = 93;
export const LAST_PRE = "20261117000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} THROUGH ${POST_LAST} TO STAGING ${APPROVED_REF}`;

/** The tables the three migrations touch; every fingerprint below is taken over exactly these. */
export const TOUCHED = ["report_sec013", "report_sec014", "report_sec014_patrols", "report_sec018", "report_sec029", "report_sec033", "duty_records", "overtime_requests", "profiles"];
/** Columns each migration adds (and nothing else may be added, removed or altered). */
export const ADDED_COLUMNS = {
  report_sec013: ["ops_group"], report_sec014: ["ops_group"], report_sec018: ["ops_group"], report_sec033: ["ops_group"],
  report_sec029: ["aircraft_type_other", "flight_destination", "ops_group"],
  duty_records: ["ops_group"],
  overtime_requests: ["actual_check_in", "actual_check_out", "calculated_at", "ops_group", "scheduled_end", "scheduled_start"],
  profiles: ["approved_at", "approved_by", "rejection_reason"],
};
/** Constraints whose definition changes (same name), and the one that is added. */
export const CHANGED_CONSTRAINTS = ["overtime_requests:overtime_requests_category_check", "report_sec014_patrols:report_sec014_patrols_entry_no_check", "report_sec014_patrols:report_sec014_patrols_location_check"];
export const ADDED_CONSTRAINTS = ["profiles:profiles_approved_by_fkey"];
export const ADDED_INDEXES = ["overtime_requests:overtime_requests_duty_category_uniq"];
export const LEGACY_AUTHORITY_COLUMNS = ["org_id", "unified_role", "duty_post"];

/**
 * Exact hosted pre-state, frozen from a read-only observation of the approved staging project on 2026-10-21 (information_schema / pg_catalog only):
 * every touched table is empty except profiles (56 rows). Any difference aborts the run before anything is written.
 */
export const PRE_STATE = {
  columnsMd5: "ba92e234b4bea733ce4f92d753175474",
  constraintsMd5: "4f527f9027605b68d4ca734dac6a6045",
  indexesMd5: "69fa40d295656055a95110467fd4e850",
  policiesMd5: "187fec43d3a5e424335104e33158871b",
  tableGrantsMd5: "a41069ebbb1fef89b4bf81e841aedbac",
  columnGrantsMd5: "d478ab79ba41cbbcee4ab7bd27707ce6",
  triggersMd5: "e7ce7c56c93b7677893d55efc26b5b6b",
};

export const WRITER = "aso";
export const OTHER_STATION = "aso-jhb";
/** SEC013 is the Profiling ASO's only form (report_form_assignments); every other form is the standard ASO's. */
export const FORM_ACTOR = { report_sec013: "profiling_aso" };
/** Probes the dry run must complete (every role in the review manifest present). The run is refused if fewer or more were executed. */
export const EXPECTED_PROBES = 19;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");

const ALLOWED_TABLES = "report_sec013|report_sec014|report_sec018|report_sec029|report_sec033|duty_records|overtime_requests";
/** Statements the migrations may contain (comments removed, whitespace collapsed, lower-cased, dollar-quoted bodies replaced by ''). */
const ALLOWED_STATEMENTS = [
  /^set local lock_timeout = '5s'$/,
  new RegExp(`^alter table public\\.(${ALLOWED_TABLES}) add column if not exists ops_group text$`),
  /^alter table public\.report_sec029 add column if not exists flight_destination text, add column if not exists aircraft_type_other text$/,
  /^do ''$/,
  /^alter table public\.report_sec014_patrols add constraint report_sec014_patrols_entry_no_check check \(entry_no >= 1\)$/,
  /^alter table public\.report_sec014_patrols add constraint report_sec014_patrols_location_check check \(location = any \(array\['apron'::text, 'terminal'::text, 'premises'::text, 'aircraft'::text\]\)\)$/,
  /^alter table public\.overtime_requests add column if not exists actual_check_in timestamptz, add column if not exists actual_check_out timestamptz, add column if not exists scheduled_start timestamptz, add column if not exists scheduled_end timestamptz, add column if not exists calculated_at timestamptz not null default now\(\)$/,
  /^alter table public\.overtime_requests add constraint overtime_requests_category_check check \(category = any \(array\['flight_delay', 'manpower_shortage', 'event', 'off_day_work', 'adhoc', 'early_arrival', 'late_departure'\]::text\[\]\)\)$/,
  /^create unique index if not exists overtime_requests_duty_category_uniq on public\.overtime_requests \(linked_duty_id, category\)$/,
  /^alter table public\.profiles add column if not exists approved_by uuid references public\.profiles\(id\), add column if not exists approved_at timestamptz, add column if not exists rejection_reason text$/,
];
/** What a DO block body may never contain, and the only dynamic statements it may execute. */
const DO_DENY = /\b(grant|revoke|truncate|delete\s+from|insert\s+into|update\s+\w+\s+set|create\s+(policy|function|trigger|table|index|schema|role)|drop\s+(table|policy|function|trigger|index|column|schema)|alter\s+(policy|role|function|default)|storage\.|org_id|unified_role|duty_post)\b/i;
const DO_EXECUTE_OK = /^execute format\('alter table public\.(report_sec014_patrols|overtime_requests) drop constraint %I', c\.conname\)$/i;

/** Returns the first statement or DO body of a migration that is not on the allow-list, or null. */
export function statementAudit(sql) {
  const raw = String(sql).replace(/--.*$/gm, "");
  for (const m of raw.matchAll(/\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g)) {
    const body = m[2];
    const denied = DO_DENY.exec(body);
    if (denied) return `DO body contains "${denied[0]}"`;
    for (const e of body.matchAll(/\bexecute\b[^;]*;/gi)) if (!DO_EXECUTE_OK.test(e[0].replace(/;$/, "").replace(/\s+/g, " ").trim())) return `DO body executes "${e[0].slice(0, 80)}"`;
  }
  const code = raw.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  const statements = code.split(";").map((s) => s.replace(/\s+/g, " ").replace(/([[(]) /g, "$1").replace(/ ([\])])/g, "$1").trim().toLowerCase()).filter(Boolean);
  const bad = statements.find((s) => !ALLOWED_STATEMENTS.some((rx) => rx.test(s)));
  return bad ? bad.slice(0, 120) : null;
}

const fail = (m) => { throw new Error(m); };

/** Each migration must match its frozen SHA-256 (LF-normalised) and contain only allow-listed statements. Returns [{...migration, file, sql}]. */
export function verifyFrozenMigrations(readFile) {
  return MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = readFile(file);
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    const sql = canonicalSql(buf); // the string that is audited, executed and recorded: identical to the string that was hashed
    const bad = statementAudit(sql);
    if (bad) fail(`${file} contains a statement outside the reviewed allow-list: ${bad}`);
    return { ...m, file, sql };
  });
}

/** Versions must be unique and ordered, immediately after LAST_PRE, and exactly the three frozen ones. */
export function orderingGate(fileNames) {
  const dated = fileNames.filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort();
  if (new Set(dated).size !== dated.length) fail("duplicate migration versions in the repository");
  const after = dated.filter((v) => v > LAST_PRE);
  if (after.join() !== MIGRATIONS.map((m) => m.version).join()) fail(`the repository holds migrations after ${LAST_PRE} other than the three frozen ones (${after.join()})`);
  if (!dated.includes(LAST_PRE)) fail(`${LAST_PRE} is not in the repository`);
}

/** Git gates: exact repository, branch, origin, clean tree, HEAD === expected head, descendant of the pushed baseline. Exported so tests exercise the real code. */
export function runnerGitGates({ expectedHead, repoPath, base = PUSHED_BASE }) {
  if (!/^[0-9a-f]{40}$/.test(String(expectedHead))) fail("--expected-head must be a full 40-character SHA");
  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: repoPath, expectedBranch: RUNNER_BRANCH });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  try { child_process.execSync(`git merge-base --is-ancestor ${base} HEAD`, { stdio: "ignore" }); } catch { fail("HEAD does not descend from the pushed baseline"); }
  return git;
}

/** The production reference must be absent from the environment, argv and the database URL host/user. */
export function productionGate(env = process.env, argv = process.argv) {
  if (JSON.stringify(env).includes(FORBIDDEN_REF) || argv.join(" ").includes(FORBIDDEN_REF)) fail("production reference present");
}

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `p0-${process.pid}.log`), l + "\n"); };

const T_LIST = TOUCHED.map((t) => `'${t}'`).join(",");
const T_OIDS = TOUCHED.map((t) => `'public.${t}'::regclass`).join(",");
const FP_SQL = {
  columnsMd5: `select md5(string_agg(table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema='public' and table_name in (${T_LIST})`,
  constraintsMd5: `select md5(string_agg(c.relname||':'||k.conname||':'||pg_get_constraintdef(k.oid), ',' order by c.relname,k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.oid in (${T_OIDS}) and k.contype <> 'n'`,
  indexesMd5: `select md5(string_agg(tablename||':'||indexname||':'||indexdef, ',' order by tablename,indexname)) h from pg_indexes where schemaname='public' and tablename in (${T_LIST})`,
  policiesMd5: `select md5(string_agg(tablename||':'||policyname||':'||cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,''), ',' order by tablename,policyname)) h from pg_policies where schemaname='public' and tablename in (${T_LIST})`,
  tableGrantsMd5: `select md5(string_agg(table_name||':'||grantee||':'||privilege_type, ',' order by table_name,grantee,privilege_type)) h from information_schema.role_table_grants where table_schema='public' and table_name in (${T_LIST})`,
  columnGrantsMd5: `select coalesce(md5(string_agg(c.relname||'.'||a.attname||':'||a.attacl::text, ',' order by c.relname,a.attname)),'none') h from pg_attribute a join pg_class c on c.oid=a.attrelid where c.oid in (${T_OIDS}) and a.attacl is not null and a.attnum>0 and not a.attisdropped`,
  triggersMd5: `select coalesce(md5(string_agg(c.relname||':'||t.tgname||':'||pg_get_triggerdef(t.oid), ',' order by c.relname,t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid in (${T_OIDS}) and not t.tgisinternal`,
};
/** Fingerprints that the changed tables must keep (the security surface): everything except columns / constraints / indexes. */
export const SECURITY_KEYS = ["policiesMd5", "tableGrantsMd5", "columnGrantsMd5", "triggersMd5"];

async function touchedFingerprint(q) {
  const out = {};
  for (const [k, sql] of Object.entries(FP_SQL)) out[k] = (await q(sql))[0].h;
  out.rls = (await q(`select md5(string_agg(relname||':'||relrowsecurity::text||':'||relforcerowsecurity::text, ',' order by relname)) h from pg_class where oid in (${T_OIDS})`))[0].h;
  return out;
}

/** md5 fingerprints of everything the migrations must NOT change. */
async function unrelatedFingerprint(q) {
  const notTouched = `table_name not in (${T_LIST})`;
  return {
    functions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    functionAcls: (await q("select md5(string_agg(p.oid::regprocedure::text||coalesce(p.proacl::text,''), ',' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace"))[0].h,
    policies: (await q("select md5(string_agg(schemaname||tablename||policyname||cmd||permissive||array_to_string(roles,',')||coalesce(qual,'')||coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    otherTables: (await q(`select md5(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public' and ${notTouched}`))[0].h,
    allGrants: (await q("select coalesce(md5(string_agg(table_name||grantee||privilege_type, ',' order by table_name, grantee, privilege_type)), 'none') h from information_schema.role_table_grants where table_schema = 'public'"))[0].h,
    otherTriggers: (await q(`select coalesce(md5(string_agg(c.relname||t.tgname||pg_get_triggerdef(t.oid), ',' order by c.relname, t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname not in (${T_LIST})`))[0].h,
    buckets: (await q("select coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)),'none') h from storage.buckets b"))[0].h,
    // profiles gains three columns by design: its data is fingerprinted without them
    profiles: (await q("select coalesce(md5(string_agg(md5((to_jsonb(p) - 'approved_by' - 'approved_at' - 'rejection_reason')::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
    touchedRows: (await q(`select ${TOUCHED.filter((t) => t !== "profiles").map((t) => `(select count(*) from public.${t})::text`).join("||'/'||")} h`))[0].h,
  };
}
const historyFingerprint = async (q) => (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h;

const colMap = async (q) => {
  const rows = await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') d from information_schema.columns where table_schema='public' and table_name in (${T_LIST})`);
  return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, `${r.data_type}|${r.is_nullable}|${r.d}`]));
};
const conMap = async (q) => new Map((await q(`select c.relname||':'||k.conname id, pg_get_constraintdef(k.oid) d from pg_constraint k join pg_class c on c.oid=k.conrelid where c.oid in (${T_OIDS}) and k.contype <> 'n'`)).map((r) => [r.id, r.d]));
const idxMap = async (q) => new Map((await q(`select tablename||':'||indexname id, indexdef d from pg_indexes where schemaname='public' and tablename in (${T_LIST})`)).map((r) => [r.id, r.d]));
const added = (b, a) => [...a.keys()].filter((k) => !b.has(k)).sort();
const removed = (b, a) => [...b.keys()].filter((k) => !a.has(k)).sort();
const changed = (b, a) => [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort();

/** Verifies the hosted pre-state. `hashes` (the frozen staging observation) is null only in the local verifier. */
export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("a P0 migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  if (ctx.hashes) {
    const fp = await touchedFingerprint(q);
    for (const k of Object.keys(ctx.hashes)) if (fp[k] !== ctx.hashes[k]) fail(`${k} differs from the observed pre-state`);
  }
  const cols = await colMap(q);
  for (const [t, list] of Object.entries(ADDED_COLUMNS)) for (const c of list) if (cols.has(`${t}.${c}`)) fail(`${t}.${c} already exists: this migration set has been partly applied`);
  // hosted has no legacy authority column on profiles (pinned exactly by the frozen column fingerprint); the disposable verifier database keeps its canonical ones
  if (ctx.hashes) for (const c of LEGACY_AUTHORITY_COLUMNS.concat("ops_group")) if (cols.has(`profiles.${c}`)) fail(`profiles.${c} exists: a legacy authority column is present`);
  const cons = await conMap(q);
  if (!/entry_no <= 15/.test(cons.get("report_sec014_patrols:report_sec014_patrols_entry_no_check") ?? "")) fail("the SEC014 entry cap is not in its observed pre-state form");
  if (/Apron/.test(cons.get("report_sec014_patrols:report_sec014_patrols_location_check") ?? "x")) fail("the SEC014 location check already allows Apron");
  if (/early_arrival/.test(cons.get("overtime_requests:overtime_requests_category_check") ?? "x")) fail("the overtime category check already allows early_arrival");
  if (cons.has("profiles:profiles_approved_by_fkey")) fail("profiles_approved_by_fkey already exists");
  if ((await idxMap(q)).has(ADDED_INDEXES[0])) fail("the overtime unique index already exists");
  const dup = (await q("select count(*)::int n from (select 1 from public.overtime_requests group by linked_duty_id, category having count(*) > 1) d"))[0].n;
  if (dup) fail(`overtime_requests holds ${dup} duplicate (linked_duty_id, category) group(s)`);
  for (const r of await q(`select relname, relrowsecurity r from pg_class where oid in (${T_OIDS})`)) if (r.r !== true) fail(`row level security is not enabled on ${r.relname}`);
}

/** Read-only post-apply verification: history, structure, security surface. Used after the live apply and by --verify-applied. */
export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== (ctx.postCount ?? POST_COUNT) || mig[mig.length - 1]?.version !== (ctx.postLast ?? POST_LAST)) fail(`history is not ${ctx.postCount ?? POST_COUNT} ending ${ctx.postLast ?? POST_LAST} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  for (const m of MIGRATIONS) if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) fail(`${m.version} is not recorded exactly once with its name`);
  const cols = await colMap(q);
  for (const [t, list] of Object.entries(ADDED_COLUMNS)) for (const c of list) if (!cols.has(`${t}.${c}`)) fail(`${t}.${c} is missing`);
  if (ctx.hashes) for (const c of LEGACY_AUTHORITY_COLUMNS.concat("ops_group")) if (cols.has(`profiles.${c}`)) fail(`profiles.${c} exists`);
  const cons = await conMap(q);
  if (/entry_no <= 15/.test(cons.get("report_sec014_patrols:report_sec014_patrols_entry_no_check") ?? "")) fail("the SEC014 entry cap is still 15");
  if (!/Apron/.test(cons.get("report_sec014_patrols:report_sec014_patrols_location_check") ?? "")) fail("the SEC014 location check does not allow Apron");
  const cat = cons.get("overtime_requests:overtime_requests_category_check") ?? "";
  if (!/early_arrival/.test(cat) || !/late_departure/.test(cat)) fail("the overtime category check does not allow early_arrival and late_departure");
  if (!cons.has(ADDED_CONSTRAINTS[0])) fail("profiles_approved_by_fkey is missing");
  const idx = await q("select i.indisunique, i.indpred is null plain, i.indnatts from pg_index i where i.indexrelid = to_regclass('public.overtime_requests_duty_category_uniq')");
  if (idx.length !== 1 || !idx[0].indisunique || !idx[0].plain || idx[0].indnatts !== 2) fail("overtime_requests_duty_category_uniq is not a plain two-column unique index");
  const fp = await touchedFingerprint(q);
  if (ctx.pre) {
    for (const k of SECURITY_KEYS.concat("rls")) if (fp[k] !== ctx.pre[k]) fail(`${k} changed`);
  } else if (ctx.hashes) {
    for (const k of SECURITY_KEYS) if (fp[k] !== ctx.hashes[k]) fail(`${k} differs from the frozen pre-state`);
  }
  return { history: mig.length, last: mig[mig.length - 1].version, fp };
}

/**
 * The whole rollout as one unit: verify pre-state, snapshot fingerprints, dry run (apply + checks + probes + ROLLBACK), prove nothing changed, and
 * only if ctx.live commit a second, identical pass. Exported so the local verifier can run the identical code against disposable PostgreSQL.
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, onSnapshot?, expectedProbes? }
 */
export async function execute(client, ctx) {
  const { acct, log } = ctx;
  // whatever the caller hands in is canonicalized and must hash to the frozen SHA-256: execute() can never run bytes the frozen hash does not represent
  const files = ctx.files.map((f) => ({ ...f, sql: canonicalSql(f.sql) }));
  for (const f of files) {
    if (f.sha256 && normalisedSha256(f.sql) !== f.sha256) fail(`${f.file}: the SQL to execute does not match its frozen SHA-256`);
    const bad = statementAudit(f.sql);
    if (bad) fail(`${f.file} contains a statement outside the reviewed allow-list: ${bad}`);
  }
  const q = async (s, p) => (await client.query(s, p)).rows;
  const probes = [];
  const probe = (name) => { probes.push(name); log(`PROBE PASS: ${name}`); };

  await verifyPreState(q, { ...ctx, files });
  log("hosted pre-state verified exactly (history, columns, constraints, indexes, policies, grants, triggers, RLS, no duplicates, no legacy authority column)");
  const pre = await unrelatedFingerprint(q);
  const preTouched = await touchedFingerprint(q);
  const preHistory = await historyFingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    constraints: await q(`select c.relname, k.conname, pg_get_constraintdef(k.oid) d from pg_constraint k join pg_class c on c.oid=k.conrelid where c.oid in (${T_OIDS}) and k.contype <> 'n' order by 1,2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' and tablename in (${T_LIST}) order by 1,2`),
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name in (${T_LIST}) order by table_name, ordinal_position`),
    fingerprints: { unrelated: pre, touched: preTouched, history: preHistory },
  };
  if (ctx.onSnapshot) await ctx.onSnapshot(snapshot);

  // real-role helper: set the JWT claims and role inside a savepoint; the savepoint is always rolled back
  const asRole = async (uid, role, fn) => {
    await client.query("SAVEPOINT pr");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
      return await fn();
    } catch (e) { return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 110)}`; } finally { await client.query("ROLLBACK TO SAVEPOINT pr"); }
  };
  const asUser = (label, fn) => asRole(acct(label), "authenticated", fn);
  const switchTo = (uid, role = "authenticated") => client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
  const ins = async (table, row, returning = true) => {
    const cols = Object.keys(row);
    if (!cols.every((c) => /^[a-z_0-9]+$/.test(c)) || !/^[a-z_0-9]+$/.test(table)) fail("unsafe identifier in a probe payload");
    return (await client.query(`insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})${returning ? " returning id" : ""}`, cols.map((c) => row[c]))).rows[0]?.id;
  };

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const colsBefore = await colMap(q), consBefore = await conMap(q), idxBefore = await idxMap(q);
    try {
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      // ---- history: exactly the three new rows, each once
      const hist = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
      if (hist.n !== ctx.preCount + files.length || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} ending ${files[files.length - 1].version} (${hist.n} / ${hist.v})`);
      for (const f of files) if ((await q("select count(*)::int n from supabase_migrations.schema_migrations where version = $1", [f.version]))[0].n !== 1) fail(`${f.version} is not recorded exactly once`);
      log(`migration history is ${hist.n} ending ${hist.v}, each P0 version recorded exactly once`);

      // ---- structure: exactly the designed additions and nothing else changed in the touched tables
      const colsAfter = await colMap(q), consAfter = await conMap(q), idxAfter = await idxMap(q);
      const wantCols = Object.entries(ADDED_COLUMNS).flatMap(([t, l]) => l.map((c) => `${t}.${c}`)).sort();
      if (added(colsBefore, colsAfter).join() !== wantCols.join() || removed(colsBefore, colsAfter).length || changed(colsBefore, colsAfter).length) fail(`touched-table columns changed other than designed (added ${added(colsBefore, colsAfter).length}/${wantCols.length}; removed ${removed(colsBefore, colsAfter).length}; altered ${changed(colsBefore, colsAfter).length})`);
      if (added(consBefore, consAfter).join() !== ADDED_CONSTRAINTS.join() || removed(consBefore, consAfter).length || changed(consBefore, consAfter).join() !== CHANGED_CONSTRAINTS.slice().sort().join()) fail(`touched-table constraints changed other than designed (added ${added(consBefore, consAfter).join()}; removed ${removed(consBefore, consAfter).join()}; altered ${changed(consBefore, consAfter).join()})`);
      if (added(idxBefore, idxAfter).join() !== ADDED_INDEXES.join() || removed(idxBefore, idxAfter).length || changed(idxBefore, idxAfter).length) fail("touched-table indexes changed other than designed");
      probe(`structure: exactly ${wantCols.length} columns, 1 foreign key, 3 re-defined CHECKs and 1 unique index changed; nothing removed or altered`);
      const defs = { "overtime_requests.calculated_at": /timestamp with time zone\|NO\|now\(\)/, "overtime_requests.actual_check_in": /timestamp with time zone\|YES\|$/, "profiles.approved_by": /uuid\|YES\|$/, "report_sec029.flight_destination": /text\|YES\|$/, "report_sec029.aircraft_type_other": /text\|YES\|$/ };
      for (const [k, rx] of Object.entries(defs)) if (!rx.test(colsAfter.get(k) ?? "")) fail(`${k} does not match its designed definition (${colsAfter.get(k)})`);
      if ([...colsAfter.keys()].some((k) => /\.(org_id|unified_role|duty_post)$/.test(k) && !colsBefore.has(k))) fail("a legacy authority column appeared");
      if (colsAfter.has("profiles.ops_group") && !colsBefore.has("profiles.ops_group")) fail("profiles.ops_group appeared");
      probe("no org_id / unified_role / duty_post / profile ops_group column was added anywhere; designed column definitions match");
      const touchedAfter = await touchedFingerprint(q);
      for (const k of SECURITY_KEYS.concat("rls")) if (touchedAfter[k] !== preTouched[k]) fail(`the security surface of the touched tables changed (${k})`);
      probe("RLS flags, policies, table grants, column grants and triggers of the nine touched tables are byte-identical to the pre-state");
      const mid = await unrelatedFingerprint(q);
      for (const k of Object.keys(pre)) if (mid[k] !== pre[k]) fail(`the migrations changed something they must not (${k})`);
      probe("every unrelated fingerprint is unchanged (functions, function ACLs, policies, other tables, all grants, other triggers, storage buckets, profiles data, assignments, Auth users, row counts)");
      const ix = (await q("select i.indisunique, i.indpred is null plain, i.indnatts from pg_index i where i.indexrelid = 'public.overtime_requests_duty_category_uniq'::regclass"))[0];
      if (!ix.indisunique || !ix.plain || ix.indnatts !== 2) fail("the unique index is not a plain two-column unique index");

      // ---- application-shaped probes as the real authenticated roles (everything below is rolled back with the transaction)
      const today = (await q("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d"))[0].d;
      const now = new Date(); const later = new Date(now.getTime() + 3600e3);
      const identity = async (label) => {
        const r = (await q("select id, station, team, name, staff_no from public.profiles where id = $1", [acct(label)]))[0];
        if (!r?.station || !r?.team) fail(`${label} has no station / team on its profile`);
        return { who: { profile_id: r.id, station: r.station, team: r.team }, person: { staff_name: r.name ?? "P0 probe", staff_id: r.staff_no ?? "P0" } };
      };
      const payloadFor = (table, id) => {
        const { who, person } = id;
        switch (table) {
          case "report_sec013": return { ...who, ...person, date_time_in: now.toISOString(), date_time_out: later.toISOString(), ops_group: null };
          case "report_sec014": return { ...who, ...person, date_time_in: now.toISOString(), remark: "p0 probe", ops_group: null };
          case "report_sec018": return { ...who, staff_name: person.staff_name, date_time: now.toISOString(), ops_group: null };
          case "report_sec033": return { ...who, ...person, report_date: today, report_time: "10:00", ops_group: null };
          case "report_sec029": return { ...who, ...person, supervising_officer_name: "SO", supervising_officer_id: "SO1", assisted_by_name: "AB", assisted_by_id: "AB1", aircraft_type: "A320", flight_no: "AK703", aircraft_registration: "9M-P0", std: "10:00", ops_group: null, aircraft_type_other: "Sample", flight_destination: "KUL" };
          default: return fail("unknown probe table");
        }
      };
      const asoId = await identity(WRITER);
      const p = { id: asoId.who.profile_id, station: asoId.who.station };
      const reports = Object.fromEntries(["report_sec013", "report_sec014", "report_sec018", "report_sec029", "report_sec033"].map((t) => [t, null]));
      for (const table of Object.keys(reports)) {
        const actor = FORM_ACTOR[table] ?? WRITER;
        const payload = payloadFor(table, actor === WRITER ? asoId : await identity(actor));
        reports[table] = payload;
        const label = table.replace("report_", "").toUpperCase();
        const r = await asUser(actor, async () => { const id = await ins(table, payload); return typeof id === "string" ? "ok" : "no id"; });
        if (r !== "ok") fail(`${label} submission failed for ${actor}: ${r}`);
        probe(`${actor}: ${label} submission (the application's payload incl. ops_group null${table === "report_sec029" ? ", aircraft_type_other and flight_destination" : ""}) succeeds`);
      }
      const patrol = await asUser(WRITER, async () => {
        const rid = await ins("report_sec014", reports.report_sec014);
        const out = [];
        for (const [entry, loc] of [[1, "Apron"], [16, "Apron"], [15, "Terminal"], [2, "Aircraft"]]) { await ins("report_sec014_patrols", { report_id: rid, entry_no: entry, location: loc }, false); out.push(`${entry}:${loc}`); }
        const bad = [];
        for (const [entry, loc] of [[0, "Apron"], [1, "Garage"]]) {
          await client.query("SAVEPOINT bad");
          try { await ins("report_sec014_patrols", { report_id: rid, entry_no: entry, location: loc }, false); bad.push("ALLOWED"); } catch (e) { bad.push(e.code); }
          await client.query("ROLLBACK TO SAVEPOINT bad");
        }
        return `${out.join(",")}|${bad.join(",")}`;
      });
      if (patrol !== "1:Apron,16:Apron,15:Terminal,2:Aircraft|23514,23514") fail(`SEC014 patrol entries behaved unexpectedly (${patrol})`);
      probe(`${WRITER}: SEC014 patrol entries accept Apron and entry 16, still accept Terminal and Aircraft, and still reject entry 0 and an unknown location (23514)`);

      const duty = await asUser(WRITER, async () => {
        const dutyId = await ins("duty_records", { profile_id: p.id, station: p.station, duty_date: today, shift_code: "M", ops_group: null });
        const ot = (category, extra = {}) => ({ profile_id: p.id, station: p.station, work_date: today, start_at: now.toISOString(), end_at: later.toISOString(), category, reason: "p0 probe", linked_duty_id: dutyId, ops_group: null, actual_check_in: now.toISOString(), actual_check_out: later.toISOString(), scheduled_start: now.toISOString(), scheduled_end: later.toISOString(), ...extra });
        await ins("overtime_requests", ot("early_arrival"));
        await ins("overtime_requests", ot("late_departure"));
        const both = (await client.query("select count(*)::int n from public.overtime_requests where linked_duty_id = $1", [dutyId])).rows[0].n;
        const upsert = await client.query("insert into public.overtime_requests (profile_id, station, work_date, start_at, end_at, category, reason, linked_duty_id) values ($1,$2,$3,$4,$5,'early_arrival','again',$6) on conflict (linked_duty_id, category) do nothing", [p.id, p.station, today, now.toISOString(), later.toISOString(), dutyId]);
        const after = (await client.query("select count(*)::int n from public.overtime_requests where linked_duty_id = $1", [dutyId])).rows[0].n;
        await client.query("SAVEPOINT bad");
        let dupe = "ALLOWED"; try { await ins("overtime_requests", ot("early_arrival")); } catch (e) { dupe = e.code; }
        await client.query("ROLLBACK TO SAVEPOINT bad");
        await client.query("SAVEPOINT bad");
        let bogus = "ALLOWED"; try { await ins("overtime_requests", ot("bogus")); } catch (e) { bogus = e.code; }
        await client.query("ROLLBACK TO SAVEPOINT bad");
        const calc = (await client.query("select calculated_at is not null c from public.overtime_requests where linked_duty_id = $1 limit 1", [dutyId])).rows[0].c;
        return `${both}|${upsert.rowCount}|${after}|${dupe}|${bogus}|${calc}`;
      });
      if (duty !== "2|0|2|23505|23514|true") fail(`duty / overtime probes behaved unexpectedly (${duty})`);
      probe(`${WRITER}: duty check-in payload (ops_group null) succeeds`);
      probe(`${WRITER}: early-arrival and late-departure overtime payloads (actual/scheduled times, ops_group null) succeed and coexist for one duty record (2 rows)`);
      probe(`${WRITER}: a repeated upsert on (linked_duty_id, category) creates no duplicate, a direct duplicate is refused (23505), an unknown category is refused (23514), calculated_at is populated`);

      // ---- profile approval / rejection audit (a real approved profile of the review set is the approver; the changes are rolled back)
      const approver = acct("operation_manager");
      const prof = await q("select id from public.profiles where id <> $1 and id <> $2 order by id limit 2", [approver, acct(WRITER)]);
      if (prof.length < 2) fail("not enough profiles for the approval / rejection probes");
      const audit = await asRole(null, "service_role", async () => {
        await client.query("SAVEPOINT aud");
        try {
          const a = await client.query("update public.profiles set approved_by = $1, approved_at = now() where id = $2", [approver, prof[0].id]);
          const r = await client.query("update public.profiles set rejection_reason = 'p0 probe: scope mismatch', approved_by = $1, approved_at = now() where id = $2", [approver, prof[1].id]);
          let fk = "ALLOWED"; await client.query("SAVEPOINT fk");
          try { await client.query("update public.profiles set approved_by = gen_random_uuid() where id = $1", [prof[0].id]); } catch (e) { fk = e.code; }
          await client.query("ROLLBACK TO SAVEPOINT fk");
          const back = (await client.query("select (select approved_by::text from public.profiles where id = $1) a, (select rejection_reason from public.profiles where id = $2) r", [prof[0].id, prof[1].id])).rows[0];
          return `${a.rowCount}|${r.rowCount}|${fk}|${back.a === approver}|${back.r}`;
        } finally { await client.query("ROLLBACK TO SAVEPOINT aud"); }
      });
      if (audit !== "1|1|23503|true|p0 probe: scope mismatch") fail(`profile approval / rejection audit probes behaved unexpectedly (${audit})`);
      probe("profile approval audit (approved_by, approved_at) and rejection audit (rejection_reason) updates succeed for the service role (the authorized-admin path is exercised in the hosted UAT); an approved_by that is not a profile is refused (23503)");

      // ---- existing segregation is unchanged: the author sees the row, another station's officer and anonymous see nothing / are refused
      const seg = await asUser(FORM_ACTOR.report_sec013, async () => {
        const id = await ins("report_sec013", reports.report_sec013);
        const mine = (await client.query("select count(*)::int n from public.report_sec013 where id = $1", [id])).rows[0].n;
        await switchTo(acct(OTHER_STATION));
        const theirs = (await client.query("select count(*)::int n from public.report_sec013 where id = $1", [id])).rows[0].n;
        await switchTo(acct("operation_manager"));
        const lead = (await client.query("select count(*)::int n from public.report_sec013 where id = $1", [id])).rows[0].n;
        return `${mine}|${theirs}|${lead}`;
      });
      if (!/^1\|0\|[01]$/.test(seg)) fail(`report segregation changed (${seg})`);
      probe(`${FORM_ACTOR.report_sec013} sees the SEC013 row they wrote; ${OTHER_STATION} (another station) sees 0 rows`);
      const anon = await asRole(null, "anon", async () => { await client.query("select count(*) from public.report_sec013"); return "ALLOWED"; });
      if (anon === "ALLOWED" || !/permission denied/i.test(anon)) fail(`anon was not refused on report_sec013 (${anon})`);
      probe("anon: refused on report_sec013");
      const anonOt = await asRole(null, "anon", async () => { await client.query("select count(*) from public.overtime_requests"); return "ALLOWED"; });
      if (anonOt === "ALLOWED" || !/permission denied/i.test(anonOt)) fail(`anon was not refused on overtime_requests (${anonOt})`);
      probe("anon: refused on overtime_requests");
      const anonProf = await asRole(null, "anon", async () => { await client.query("update public.profiles set approved_by = null"); return "ALLOWED"; });
      if (anonProf === "ALLOWED" || !/permission denied/i.test(anonProf)) fail(`anon could write profiles (${anonProf})`);
      probe("anon: cannot write profile approval fields");
      // a plain staff member cannot use the new audit columns to approve themselves
      const selfApprove = await asUser(WRITER, async () => {
        await client.query("SAVEPOINT sa");
        try { const r = await client.query("update public.profiles set approved_by = $1, approved_at = now() where id = $1", [p.id]); return r.rowCount === 0 ? "no-row" : "ALLOWED"; } catch (e) { return `ERR:${e.code ?? ""}`; }
      });
      if (selfApprove === "ALLOWED") fail("a station officer could set their own approval audit fields");
      probe(`${WRITER}: cannot set their own approval audit fields (${selfApprove})`);

      if (real) await client.query("COMMIT"); else await client.query("ROLLBACK");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  await pass(false);
  log("dry run rolled back");
  if (ctx.expectedProbes !== undefined && probes.length !== ctx.expectedProbes) fail(`incomplete probe execution: ${probes.length} probes passed, ${ctx.expectedProbes} are required`);
  log(`all ${probes.length} required probes completed in the dry run`);
  await verifyPreState(q, { ...ctx, files });
  const afterDry = await unrelatedFingerprint(q);
  for (const k of Object.keys(pre)) if (afterDry[k] !== pre[k]) fail(`staging changed after the rolled-back dry run (${k})`);
  const afterTouched = await touchedFingerprint(q);
  for (const k of Object.keys(preTouched)) if (afterTouched[k] !== preTouched[k]) fail(`the touched tables changed after the rolled-back dry run (${k})`);
  if ((await historyFingerprint(q)) !== preHistory) fail("migration history changed after the rolled-back dry run");
  log("staging is unchanged after the dry-run rollback (history 93, columns, constraints, indexes, policies, grants, triggers, every fingerprint)");
  let committed = false;
  if (ctx.live) {
    const dryProbes = probes.length;
    await pass(true);
    committed = true;
    if (ctx.expectedProbes !== undefined && probes.length !== 2 * dryProbes) fail("incomplete probe execution in the live pass");
    const post = await unrelatedFingerprint(q);
    for (const k of Object.keys(pre)) if (post[k] !== pre[k]) fail(`after the live apply an unrelated fingerprint changed (${k})`);
    const v = await verifyApplied(q, { pre: preTouched, postCount: ctx.preCount + files.length, postLast: files[files.length - 1].version });
    log(`LIVE: migrations committed and verified (history ${v.history} ending ${v.last})`);
  }
  return { probes, committed, snapshot };
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const LIVE = args.includes("--live");
  const log = defaultLog;
  productionGate();
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  if (args.includes("--verify-applied")) {
    const { client, explicitCa } = await connectVerified();
    log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
    try {
      await client.query("begin read only");
      const v = await verifyApplied(async (s, p) => (await client.query(s, p)).rows, { hashes: PRE_STATE });
      await client.query("rollback");
      log(`VERIFIED: history ${v.history} ending ${v.last}; the three P0 migrations are recorded and present; the security surface of the touched tables equals the frozen pre-state`);
    } finally { await client.end().catch(() => {}); }
    return;
  }
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`P0 migrations: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

  const git = runnerGitGates({ expectedHead, repoPath: path.resolve(import.meta.dirname, "../..") });
  log(`HEAD=${git.head.slice(0, 12)}; branch ${RUNNER_BRANCH}, origin and pushed-baseline ancestry verified; working tree clean`);
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(freshBackup)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  const migDir = path.join(git.root, "supabase", "migrations");
  orderingGate(fs.readdirSync(migDir));
  const files = verifyFrozenMigrations((f) => fs.readFileSync(path.join(migDir, f)));
  log(`${files.length} migrations match their frozen SHA-256, contain only allow-listed statements and are the only migrations after ${LAST_PRE}, unique and ordered`);

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    if ((await client.query("select count(*)::int n from auth.users")).rows[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    const result = await execute(client, {
      files, acct, live: LIVE, log, preCount: PRE_COUNT, lastPre: LAST_PRE, hashes: PRE_STATE, expectedProbes: EXPECTED_PROBES,
      onSnapshot: async (snapshot) => {
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-p0-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (columns, constraints, indexes, fingerprints) written and re-authenticated (${path.basename(snap)})`);
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
