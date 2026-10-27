#!/usr/bin/env node
// Applies ONLY the frozen "retire standalone Offload report creation" migration to the approved staging project. PREPARED, NOT EXECUTED unless --live.
//   20261127000001_retire_standalone_offload_report
//     -- can_create_report_form('offload') becomes false for every caller, list_my_report_forms_secure() stops offering it, and the 'offload' rows of
//        report_form_assignments are REVOKED (kept). Historical offload_records / offload_items are never referenced, so they cannot be touched.
// Same shape as the earlier guarded runners: exact branch / head / ancestry / clean tree, verified-TLS connection, authenticated fresh backup (<6 h, outside
// the repository), frozen SHA-256, statement allow-list, hosted pre-state fingerprints, a transactional dry run with real-role probes that is rolled back and
// proven to leave staging unchanged, and a --live pass only with the exact phrase. Prints names and counts only.
//
//   node --env-file=.env.local scripts/staging/apply-offload-retirement-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-offload-retirement-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
//   node --env-file=.env.local scripts/staging/apply-offload-retirement-migration.mjs --verify-applied                                            (read-only)
//   node --env-file=.env.local scripts/staging/apply-offload-retirement-migration.mjs --observe                                                   (read-only pre-state)
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
  { version: "20261127000001", name: "retire_standalone_offload_report", sha256: "d26495eeae10c6b8924bffbe5e36a1979c7b9afbd7c4e95d0ec5ad928117f521" },
];
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The pushed baseline carrying the certified rollout; HEAD must descend from it. */
export const PUSHED_BASE = "91a8b6dc7dd4f8b91adfdd829f683e19f62b8f39";
export const PRE_COUNT = 100;
export const LAST_PRE = "20261120000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;
export const CAN_CREATE_FN = "can_create_report_form";
export const LIST_FN = "list_my_report_forms_secure";

/** Frozen from a read-only observation of the approved staging project (run `--observe`); any difference aborts before anything is written. */
export const PRE_STATE = {
  canMd5: "6d5215e37102b83a913d9c286ecabdfd",
  listMd5: "d7017ce2978df0874f4919ccb6fe047d",
  offloadAssignmentsTotal: 20,
  offloadAssignmentsMd5: "d5f4f65f86074e3aa5555e382fe802e3",
  recordsMd5: "none",
  itemsMd5: "none",
};
export const EXPECTED_PROBES = 14;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const md5 = (t) => crypto.createHash("md5").update(String(t ?? "")).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^create or replace function public\.can_create_report_form\(p_form text\) returns boolean language sql stable security definer set search_path to 'public' as ''$/,
  /^create or replace function public\.list_my_report_forms_secure\(\) returns table \(form_type text\) language sql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.can_create_report_form\(text\) from public, anon$/,
  /^grant execute on function public\.can_create_report_form\(text\) to authenticated, service_role$/,
  /^revoke execute on function public\.list_my_report_forms_secure\(\) from public, anon$/,
  /^grant execute on function public\.list_my_report_forms_secure\(\) to authenticated, service_role$/,
  /^update public\.report_form_assignments set revoked_at = now\(\) where form_type = 'offload' and revoked_at is null$/,
];
/** What the dollar-quoted function bodies may never contain. */
const BODY_DENY = /\b(grant|revoke|truncate|delete\s+from|insert\s+into|update\s+\w+\s+set|create\s+(policy|function|trigger|table|index|schema|role)|drop\s+|alter\s+(table|policy|role|function|default)|storage\.|offload_records|offload_items)\b/i;

/** Returns the first statement of a migration that is not on the allow-list, or null. */
export function statementAudit(sql) {
  const raw = String(sql).replace(/--.*$/gm, "");
  for (const m of raw.matchAll(/\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g)) {
    const denied = BODY_DENY.exec(m[2]);
    if (denied) return `function body contains "${denied[0]}"`;
  }
  const code = raw.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  const statements = code.split(";").map((s) => s.replace(/\s+/g, " ").replace(/([[(]) /g, "$1").replace(/ ([\])])/g, "$1").trim().toLowerCase()).filter(Boolean);
  const bad = statements.find((s) => !ALLOWED_STATEMENTS.some((rx) => rx.test(s)));
  if (bad) return bad.slice(0, 120);
  if (statements.length !== ALLOWED_STATEMENTS.length) return `expected exactly ${ALLOWED_STATEMENTS.length} statements, found ${statements.length}`;
  if (/offload_records|offload_items/i.test(code)) return "the migration references the historical offload tables";
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
  const after = dated.filter((v) => v > LAST_PRE && v <= POST_LAST); // later, separately guarded migrations are not this runner's concern
  if (after.join() !== MIGRATIONS.map((m) => m.version).join()) fail(`the repository holds migrations after ${LAST_PRE} other than the frozen one (${after.join()})`);
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

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `offload-retirement-${process.pid}.log`), l + "\n"); };

const FN_SQL = (name) => `select pg_get_functiondef(p.oid) d, p.prosecdef sd, p.provolatile vol, coalesce(p.proconfig::text,'') cfg, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${name}'`;
const OFFLOAD_ASSIGNMENTS_SQL = "select count(*)::int total, count(*) filter (where revoked_at is null)::int active, coalesce(md5(string_agg(md5((a.id, a.role_code, a.station_code, a.profile_id, a.form_type)::text), ',' order by a.id::text)), 'none') idsMd5 from public.report_form_assignments a where a.form_type = 'offload'";
const HISTORY_SQL = "select (select count(*)::int from public.offload_records) records, (select count(*)::int from public.offload_items) items, (select coalesce(md5(string_agg(md5(r::text), ',' order by r.id::text)), 'none') from public.offload_records r) recordsMd5, (select coalesce(md5(string_agg(md5(i::text), ',' order by i.id::text)), 'none') from public.offload_items i) itemsMd5";

/** The observations the frozen PRE_STATE is made of (also what --observe prints). */
export async function observe(q) {
  const can = await q(FN_SQL(CAN_CREATE_FN));
  const list = await q(FN_SQL(LIST_FN));
  const off = (await q(OFFLOAD_ASSIGNMENTS_SQL))[0];
  const hist = (await q(HISTORY_SQL))[0];
  const fnText = (rows) => rows.map((r) => canonicalSql(r.d) + r.sd + r.vol + r.cfg + r.acl).join("|");
  return {
    canCount: can.length, canMd5: md5(fnText(can)), canDef: can[0] ?? null,
    listCount: list.length, listMd5: md5(fnText(list)), listDef: list[0] ?? null,
    offloadAssignments: { total: off.total, active: off.active, idsMd5: off.idsmd5 ?? off.idsMd5 },
    history: { records: hist.records, items: hist.items, recordsMd5: hist.recordsmd5 ?? hist.recordsMd5, itemsMd5: hist.itemsmd5 ?? hist.itemsMd5 },
  };
}

/** Everything the migration must NOT change, as md5s. Functions exclude the two rewritten ones; the assignment table excludes only its offload rows. */
async function unrelatedFingerprint(q) {
  const skip = `p.proname not in ('${CAN_CREATE_FN}', '${LIST_FN}')`;
  return {
    otherFunctions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and ${skip} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    functionProps: (await q(`select md5(string_agg(p.oid::regprocedure::text||p.prosecdef::text||p.provolatile::text||coalesce(p.proconfig::text,'')||pg_get_userbyid(p.proowner), ',' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and ${skip}`))[0].h,
    functionExec: (await q(`select md5(string_agg(p.oid::regprocedure::text||':'||r.rolname, ',' order by p.oid::regprocedure::text, r.rolname)) h from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r(rolname) where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and ${skip} and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`))[0].h,
    policies: (await q("select md5(string_agg(schemaname||tablename||policyname||cmd||permissive||array_to_string(roles,',')||coalesce(qual,'')||coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    tablePrivs: (await q("select md5(string_agg(c.relname||':'||r.rolname||':'||p, ',' order by c.relname, r.rolname, p)) h from pg_class c cross join unnest(array['anon','authenticated','service_role']) r(rolname) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.rolname, c.oid, p)"))[0].h,
    columns: (await q("select md5(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public'"))[0].h,
    constraints: (await q("select md5(string_agg(c.relname||k.conname||pg_get_constraintdef(k.oid), ',' order by c.relname, k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype <> 'n'"))[0].h,
    triggers: (await q("select coalesce(md5(string_agg(c.relname||t.tgname||pg_get_triggerdef(t.oid)||t.tgenabled::text, ',' order by c.relname, t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"))[0].h,
    rls: (await q("select md5(string_agg(relname||relrowsecurity::text||relforcerowsecurity::text, ',' order by relname)) h from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')"))[0].h,
    buckets: (await q("select coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)),'none') h from storage.buckets b"))[0].h,
    profiles: (await q("select coalesce(md5(string_agg(md5(p::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    roleAssignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    otherFormAssignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.report_form_assignments a where a.form_type <> 'offload'"))[0].h,
    reportRows: (await q("select (select count(*) from public.report_sec013)::text||'/'||(select count(*) from public.report_sec014)::text||'/'||(select count(*) from public.report_sec016)::text||'/'||(select count(*) from public.report_sec018)::text||'/'||(select count(*) from public.report_sec029)::text||'/'||(select count(*) from public.report_sec033)::text h"))[0].h,
    transactions: (await q("select count(*)::text h from public.transactions"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
  };
}
const historyFingerprint = async (q) => (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h;

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the offload-retirement migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  const obs = await observe(q);
  if (obs.canCount !== 1 || obs.listCount !== 1) fail("can_create_report_form / list_my_report_forms_secure are not present exactly once");
  if (obs.canDef.d.includes("p_form <> 'offload'")) fail("can_create_report_form already excludes offload: it has been applied already or the schema is not the reviewed one");
  if (!obs.listDef.d.includes("'offload'")) fail("list_my_report_forms_secure no longer offers offload: it has been changed already or the schema is not the reviewed one");
  if (obs.offloadAssignments.active === 0) fail("there is no active offload assignment to revoke: it has been revoked already or the schema is not the reviewed one");
  if (ctx.hashes) {
    if (obs.canMd5 !== ctx.hashes.canMd5) fail("can_create_report_form differs from the observed pre-state");
    if (obs.listMd5 !== ctx.hashes.listMd5) fail("list_my_report_forms_secure differs from the observed pre-state");
    if (obs.offloadAssignments.idsMd5 !== ctx.hashes.offloadAssignmentsMd5 || obs.offloadAssignments.total !== ctx.hashes.offloadAssignmentsTotal) fail("the offload assignment rows differ from the observed pre-state");
    if (obs.history.recordsMd5 !== ctx.hashes.recordsMd5 || obs.history.itemsMd5 !== ctx.hashes.itemsMd5) fail("the historical offload rows differ from the observed pre-state");
  }
  return obs;
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== (ctx.postCount ?? POST_COUNT) || mig[mig.length - 1]?.version !== (ctx.postLast ?? POST_LAST)) fail(`history is not ${ctx.postCount ?? POST_COUNT} ending ${ctx.postLast ?? POST_LAST} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  for (const m of MIGRATIONS) if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) fail(`${m.version} is not recorded exactly once with its name`);
  const obs = await observe(q);
  if (!obs.canDef.d.includes("p_form <> 'offload'")) fail("can_create_report_form does not exclude offload");
  if (obs.listDef.d.includes("'offload'")) fail("list_my_report_forms_secure still offers offload");
  if (obs.offloadAssignments.active !== 0) fail(`${obs.offloadAssignments.active} offload assignment(s) are still active`);
  for (const [label, f] of [["can_create_report_form", obs.canDef], ["list_my_report_forms_secure", obs.listDef]]) {
    if (!f.sd || f.vol !== "s" || !/search_path=public/.test(f.cfg) || f.owner !== "postgres") fail(`${label} is not SECURITY DEFINER / STABLE with a fixed search_path owned by postgres`);
    if (/=X\//.test(f.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail(`${label} is executable by PUBLIC/anon`);
    if (!/authenticated=X\//.test(f.acl) || !/service_role=X\//.test(f.acl)) fail(`${label} is not executable by authenticated and service_role`);
  }
  return { history: mig.length, last: mig[mig.length - 1].version, obs };
}

/**
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, onSnapshot?, expectedProbes? }
 * Personas (manifest labels): aso (PEN) and aso-jhb (JHB) hold the standard ASO forms, profiling_aso holds SEC013 only, so/dse/operation_manager hold none,
 * neg-pending-profile is a pending profile with an active assignment.
 */
export async function execute(client, ctx) {
  const { acct, log } = ctx;
  const files = ctx.files.map((f) => ({ ...f, sql: canonicalSql(f.sql) }));
  for (const f of files) {
    if (f.sha256 && normalisedSha256(f.sql) !== f.sha256) fail(`${f.file}: the SQL to execute does not match its frozen SHA-256`);
    const bad = statementAudit(f.sql);
    if (bad) fail(`${f.file} contains a statement outside the reviewed allow-list: ${bad}`);
  }
  const q = async (s, p) => (await client.query(s, p)).rows;
  const probes = [];
  const probe = (name) => { probes.push(name); log(`PROBE PASS: ${name}`); };

  const preObs = await verifyPreState(q, { ...ctx, files });
  log("hosted pre-state verified exactly (history, both functions, the offload assignment rows, the historical offload rows)");
  const pre = await unrelatedFingerprint(q);
  const preHistory = await historyFingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    previousCanCreateReportForm: preObs.canDef.d,
    previousListMyReportFormsSecure: preObs.listDef.d,
    offloadAssignments: (await q("select * from public.report_form_assignments where form_type = 'offload' order by id")),
    fingerprints: { unrelated: pre, history: preHistory, canMd5: preObs.canMd5, listMd5: preObs.listMd5, offloadAssignments: preObs.offloadAssignments, historicalOffload: preObs.history },
  };
  if (ctx.onSnapshot) await ctx.onSnapshot(snapshot);

  const asRole = async (uid, role, fn) => {
    await client.query("SAVEPOINT pr");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
      return await fn();
    } catch (e) { return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 110)}`; } finally { await client.query("ROLLBACK TO SAVEPOINT pr"); }
  };
  const asUser = (label, fn) => asRole(acct(label), "authenticated", fn);
  const FORMS = ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "offload"];
  const canMap = (label) => asUser(label, async () => {
    const out = {};
    for (const f of FORMS) out[f] = (await client.query("select public.can_create_report_form($1) ok", [f])).rows[0].ok;
    out.list = (await client.query("select coalesce(string_agg(form_type, ',' order by form_type), '') l from public.list_my_report_forms_secure()")).rows[0].l;
    return out;
  });
  /** A standalone offload insert as this person; the table trigger must refuse it. Always rolled back by the savepoint. */
  const tryInsert = (label) => asUser(label, async () => {
    await client.query("insert into public.offload_records (profile_id, status, station, team, staff_name, staff_id, flight_no, destination, aircraft_registration, flight_date, total_bags) values ($1, 'submitted', 'PEN', 'A', 'probe', 'PROBE', 'AK0000', 'KUL', '9M-PRB', current_date, 1)", [acct(label)]);
    return "inserted";
  });

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      const before = { aso: await canMap("aso"), asoJhb: await canMap("aso-jhb"), profiling: await canMap("profiling_aso"), so: await canMap("so"), dse: await canMap("dse"), om: await canMap("operation_manager"), pending: await canMap("neg-pending-profile") };
      if (ctx.hashes) {
        if (before.aso.offload !== true || !String(before.aso.list).includes("offload")) fail("the pre-state is not the reviewed one: aso could not create or list offload before the migration");
      }
      // A synthetic HISTORICAL offload record and item (service-level insert inside this transaction, as an old submission would exist): the migration must leave it
      // byte-identical and readable by its owner. It is removed again before the transaction ends, so a live run never keeps it.
      await client.query("set local session_replication_role = replica");
      const fxRec = (await client.query("insert into public.offload_records (profile_id, status, station, team, staff_name, staff_id, flight_no, destination, aircraft_registration, flight_date, total_bags) values ($1,'submitted','PEN','A','historical probe','PROBE','AK0001','KUL','9M-HST',current_date,1) returning id", [acct("aso")])).rows[0].id;
      const fxItem = (await client.query("insert into public.offload_items (report_id, entry_no, baggage_tag_no) values ($1, 1, 'PROBE0001') returning id", [fxRec])).rows[0].id;
      await client.query("set local session_replication_role = origin");
      const fxMd5 = async () => (await q("select md5(r::text) a, (select md5(i::text) from public.offload_items i where i.id = $2) b from public.offload_records r where r.id = $1", [fxRec, fxItem]))[0];
      const fxBefore = await fxMd5();
      // the content the secure view / PDF / Excel paths render for a record (service-level, no authorization of its own): must be identical before and after
      const fxContent = async () => JSON.stringify((await q("select public.report_source_content('offload_records', $1) c", [fxRec]))[0].c);
      const fxContentBefore = await fxContent();
      if (!fxContentBefore.includes("PROBE0001")) fail("the synthetic historical record does not render its item through report_source_content");
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      const hist = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
      if (hist.n !== ctx.preCount + files.length || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} ending ${files[files.length - 1].version} (${hist.n} / ${hist.v})`);
      probe(`migration history is ${hist.n} ending ${hist.v}, the offload-retirement version recorded once`);

      // ---- structure
      const post = await observe(q);
      if (post.canMd5 === preObs.canMd5 || post.listMd5 === preObs.listMd5) fail("a rewritten function did not change");
      for (const [label, f] of [["can_create_report_form", post.canDef], ["list_my_report_forms_secure", post.listDef]]) {
        if (!f.sd || f.vol !== "s" || !/search_path=public/.test(f.cfg) || f.owner !== "postgres") fail(`${label}'s security properties are wrong`);
        if (/=X\//.test(f.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail(`${label} is executable by PUBLIC/anon`);
      }
      probe("both functions: SECURITY DEFINER, STABLE, search_path=public, owned by postgres, EXECUTE only for authenticated, service_role (and the owner)");
      if (post.offloadAssignments.total !== preObs.offloadAssignments.total || post.offloadAssignments.active !== 0) fail(`offload assignments: ${post.offloadAssignments.active} active of ${post.offloadAssignments.total} (expected 0 of ${preObs.offloadAssignments.total})`);
      probe(`all ${post.offloadAssignments.total} offload assignment rows are kept and revoked (0 active)`);
      if (post.history.records !== preObs.history.records + 1 || post.history.items !== preObs.history.items + 1) fail("historical offload row counts changed during the migration");
      const fxAfter = await fxMd5();
      if (!fxBefore || !fxAfter || fxAfter.a !== fxBefore.a || fxAfter.b !== fxBefore.b) fail("a historical offload record or item changed during the migration");
      probe(`historical Offload is untouched: the ${preObs.history.records} existing records and ${preObs.history.items} items are unchanged and a synthetic historical record plus item are byte-identical after the migration`);
      const mid = await unrelatedFingerprint(q);
      for (const k of Object.keys(pre)) if (mid[k] !== pre[k]) fail(`the migration changed something it must not (${k})`);
      probe("every unrelated fingerprint is unchanged (other function bodies, properties and EXECUTE grants, all policies, table privileges, columns, constraints, triggers, RLS, storage buckets, profiles, role assignments, every non-offload form assignment, report rows, movements, Auth users)");

      // ---- behaviour after the change, with real roles
      const after = { aso: await canMap("aso"), asoJhb: await canMap("aso-jhb"), profiling: await canMap("profiling_aso"), so: await canMap("so"), dse: await canMap("dse"), om: await canMap("operation_manager"), pending: await canMap("neg-pending-profile") };
      const STANDARD = "sec014,sec016,sec018,sec029,sec033";
      for (const [who, m] of Object.entries(after)) if (typeof m === "string" || m.offload !== false || String(m.list).includes("offload")) fail(`${who} can still create or list offload (${JSON.stringify(m)})`);
      probe("no persona can create or list a standalone Offload report any more (ASO PEN, ASO JHB, Profiling ASO, SO, DSE, Operation Manager, pending profile)");
      for (const who of ["aso", "asoJhb"]) {
        const m = after[who];
        if (m.list !== STANDARD || !["sec014", "sec016", "sec018", "sec029", "sec033"].every((f) => m[f] === true) || m.sec013 !== false) fail(`${who} lost or gained a form (${JSON.stringify(m)})`);
        if (JSON.stringify(m) !== JSON.stringify(before[who] && { ...before[who], offload: false, list: STANDARD })) fail(`${who} changed beyond the offload form`);
      }
      probe("ASO (PEN and JHB) keep SEC016, SEC014, SEC029, SEC018 and SEC033 and still have no SEC013");
      if (after.profiling.list !== "sec013" || after.profiling.sec013 !== true || FORMS.filter((f) => f !== "sec013").some((f) => after.profiling[f] !== false)) fail(`Profiling ASO changed (${JSON.stringify(after.profiling)})`);
      probe("Profiling ASO keeps SEC013 only");
      for (const who of ["so", "dse", "om", "pending"]) if (after[who].list !== "" ) fail(`${who} gained a form (${JSON.stringify(after[who])})`);
      probe("SO, DSE, Operation Manager and the pending profile still have no report form at all");
      const aspect = await asUser("aso", async () => (await client.query("select (select count(*)::int from public.report_form_assignments) n")).rows[0].n);
      if (aspect !== 0 && typeof aspect === "number") fail("an authenticated caller can read the form assignment table directly");
      probe("the form assignment table stays unreadable to authenticated callers");
      const ins = await tryInsert("aso");
      if (ins === "inserted") fail("the database still accepts a standalone offload insert from an ASO");
      if (!/does not include the offload report form|permission denied|row-level security/i.test(String(ins))) fail(`the standalone insert was refused for an unexpected reason (${ins})`);
      probe("a standalone offload_records insert by a real ASO session is refused by the database");
      const insPro = await tryInsert("profiling_aso");
      if (insPro === "inserted") fail("the database still accepts a standalone offload insert from a Profiling ASO");
      probe("a standalone offload_records insert by a Profiling ASO is refused too");
      if ((await fxContent()) !== fxContentBefore) fail("the content rendered for a historical offload record changed");
      probe("a historical Offload record still renders identically (with its item) through the secure content path that view, PDF and Excel export use");
      // remove exactly the synthetic fixture before anything can commit
      await client.query("set local session_replication_role = replica");
      const rmItem = await client.query("delete from public.offload_items where id = $1", [fxItem]);
      const rmRec = await client.query("delete from public.offload_records where id = $1", [fxRec]);
      await client.query("set local session_replication_role = origin");
      if (rmItem.rowCount !== 1 || rmRec.rowCount !== 1) fail("the synthetic historical fixture was not removed exactly");
      const cleaned = await observe(q);
      if (cleaned.history.records !== preObs.history.records || cleaned.history.items !== preObs.history.items || cleaned.history.recordsMd5 !== preObs.history.recordsMd5 || cleaned.history.itemsMd5 !== preObs.history.itemsMd5) fail("the historical offload rows differ from the pre-state after the fixture was removed");
      probe("the synthetic historical fixture was removed exactly and the real historical Offload rows equal the pre-state");
      if (before.aso.sec016 !== true) fail("pre-state sanity: aso could not create SEC016");

      if (real) await client.query("COMMIT"); else await client.query("ROLLBACK");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  await pass(false);
  log("dry run rolled back");
  if (ctx.expectedProbes !== undefined && ctx.expectedProbes > 0 && probes.length !== ctx.expectedProbes) fail(`incomplete probe execution: ${probes.length} probes passed, ${ctx.expectedProbes} are required`);
  log(`all ${probes.length} required probes completed in the dry run`);
  await verifyPreState(q, { ...ctx, files });
  const afterDry = await unrelatedFingerprint(q);
  for (const k of Object.keys(pre)) if (afterDry[k] !== pre[k]) fail(`staging changed after the rolled-back dry run (${k})`);
  const obsAfter = await observe(q);
  if (obsAfter.canMd5 !== preObs.canMd5 || obsAfter.listMd5 !== preObs.listMd5 || obsAfter.offloadAssignments.active !== preObs.offloadAssignments.active) fail("the functions or assignments changed after the rolled-back dry run");
  if ((await historyFingerprint(q)) !== preHistory) fail("migration history changed after the rolled-back dry run");
  log(`staging is unchanged after the dry-run rollback (history ${ctx.preCount}, both functions, the assignments, every fingerprint)`);
  let committed = false;
  if (ctx.live) {
    const dryProbes = probes.length;
    await pass(true);
    committed = true;
    if (ctx.expectedProbes !== undefined && ctx.expectedProbes > 0 && probes.length !== 2 * dryProbes) fail("incomplete probe execution in the live pass");
    const postFp = await unrelatedFingerprint(q);
    for (const k of Object.keys(pre)) if (postFp[k] !== pre[k]) fail(`after the live apply an unrelated fingerprint changed (${k})`);
    const v = await verifyApplied(q, { postCount: ctx.preCount + files.length, postLast: files[files.length - 1].version });
    log(`LIVE: migration committed and verified (history ${v.history} ending ${v.last})`);
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
  if (args.includes("--observe") || args.includes("--verify-applied")) {
    const { client, explicitCa } = await connectVerified();
    log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
    try {
      await client.query("begin read only");
      const rq = async (s, p) => (await client.query(s, p)).rows;
      if (args.includes("--observe")) {
        const o = await observe(rq);
        console.log(JSON.stringify({ canMd5: o.canMd5, listMd5: o.listMd5, offloadAssignmentsTotal: o.offloadAssignments.total, offloadAssignmentsActive: o.offloadAssignments.active, offloadAssignmentsMd5: o.offloadAssignments.idsMd5, recordsMd5: o.history.recordsMd5, itemsMd5: o.history.itemsMd5, records: o.history.records, items: o.history.items }, null, 1));
      } else {
        const v = await verifyApplied(rq);
        log(`VERIFIED: history ${v.history} ending ${v.last}; standalone Offload creation is closed; ${v.obs.offloadAssignments.total} offload assignment rows kept and revoked; ${v.obs.history.records} historical offload records / ${v.obs.history.items} items present`);
      }
      await client.query("rollback");
    } finally { await client.end().catch(() => {}); }
    return;
  }
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`Offload retirement migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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
  log(`${files.length} migration matches its frozen SHA-256, contains only allow-listed statements and is the only migration after ${LAST_PRE}, unique and ordered`);

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    if ((await client.query("select count(*)::int n from auth.users")).rows[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    const result = await execute(client, {
      files, acct, live: LIVE, log, preCount: PRE_COUNT, lastPre: LAST_PRE, hashes: PRE_STATE, expectedProbes: EXPECTED_PROBES,
      onSnapshot: async (snapshot) => {
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-offload-retirement-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (previous functions, offload assignment rows, fingerprints) written and re-authenticated (${path.basename(snap)})`);
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
