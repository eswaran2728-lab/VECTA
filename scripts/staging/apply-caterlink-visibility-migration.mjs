#!/usr/bin/env node
// Applies ONLY the frozen CaterLink least-privilege visibility migration to the approved staging project. PREPARED, NOT EXECUTED unless --live.
//   20261119000001_caterlink_least_privilege_transaction_read
//     -- adds public.caterlink_can_read_transaction_at_stations(...) (reuses the canonical scan / receipt / create capability model, excludes Staff Profiling)
//        and re-creates public.transactions_read_policy so station membership ALONE no longer grants access to a CaterLink movement.
// Same shape as the P0 / hardening runners: dry run first (transaction + ROLLBACK + proof nothing changed), --live only with the exact phrase, one
// transaction, every gate behavioural, refusal once history reaches 99. Prints names and counts only.
//
//   node --env-file=.env.local scripts/staging/apply-caterlink-visibility-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-caterlink-visibility-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
//   node --env-file=.env.local scripts/staging/apply-caterlink-visibility-migration.mjs --verify-applied                                            (read-only)
//   node --env-file=.env.local scripts/staging/apply-caterlink-visibility-migration.mjs --observe                                                   (read-only pre-state)
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
  { version: "20261119000001", name: "caterlink_least_privilege_transaction_read", sha256: "ccf168b0cc37a888c64c46a9626b1544a745b3050560b177a47128ecde1bd84e" },
];
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The pushed baseline carrying the verified rollout; HEAD must descend from it. */
export const PUSHED_BASE = "b4865d464b82966dff8a33ae1b6d7e672d87334f";
export const PRE_COUNT = 98;
export const LAST_PRE = "20261118000005";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;
export const NEW_FUNCTION = "caterlink_can_read_transaction_at_stations";
export const OLD_FUNCTION = "has_station_assignment_for_transaction";

/** Frozen from a read-only observation of the approved staging project (run `--observe`); any difference aborts before anything is written. */
export const PRE_STATE = {
  policyMd5: "8336bb2a40ace10822b20f34ecec5aee",
  oldFunctionMd5: "5c376065ea96d84260217054a3be4b56",
};
export const EXPECTED_PROBES = 17;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const md5 = (t) => crypto.createHash("md5").update(String(t ?? "")).digest("hex");
const fail = (m) => { throw new Error(m); };

const FN_SIG = `public\\.${NEW_FUNCTION}\\(uuid, uuid, uuid, text\\)`;
const ALLOWED_STATEMENTS = [
  /^set local lock_timeout = '5s'$/,
  new RegExp(`^create or replace function public\\.${NEW_FUNCTION}\\(p_aoc_id uuid, p_origin_station_id uuid, p_destination_station_id uuid, p_hub_destination text\\) returns boolean language plpgsql stable security definer set search_path to 'public' as ''$`),
  new RegExp(`^revoke execute on function ${FN_SIG} from public, anon$`),
  new RegExp(`^grant execute on function ${FN_SIG} to authenticated, service_role$`),
  /^drop policy transactions_read_policy on public\.transactions$/,
  /^create policy transactions_read_policy on public\.transactions for select to authenticated using \(.+\)$/,
];
/** What the dollar-quoted function body may never contain. */
const BODY_DENY = /\b(grant|revoke|truncate|delete\s+from|insert\s+into|update\s+\w+\s+set|create\s+(policy|function|trigger|table|index|schema|role)|drop\s+|alter\s+(table|policy|role|function|default)|storage\.)\b/i;

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
  const policy = statements.find((s) => s.startsWith("create policy"));
  if (!policy || !policy.includes(NEW_FUNCTION) || policy.includes(OLD_FUNCTION)) return "the policy does not use the new function exclusively";
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
  const after = dated.filter((v) => v > LAST_PRE);
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
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `caterlink-visibility-${process.pid}.log`), l + "\n"); };

const POLICY_SQL = "select pg_get_expr(p.polqual, p.polrelid) q, p.polcmd cmd, p.polpermissive perm, (select string_agg(rolname, ',' order by rolname) from pg_roles r where r.oid = any(p.polroles)) roles from pg_policy p where p.polrelid = 'public.transactions'::regclass and p.polname = 'transactions_read_policy'";
const OLD_FN_SQL = `select pg_get_functiondef(p.oid) d, p.prosecdef sd, coalesce(p.proconfig::text,'') cfg, coalesce(p.proacl::text,'') acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${OLD_FUNCTION}'`;
const NEW_FN_SQL = `select pg_get_functiondef(p.oid) d, p.prosecdef sd, p.provolatile vol, coalesce(p.proconfig::text,'') cfg, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${NEW_FUNCTION}'`;

/** The observations the frozen PRE_STATE is made of (also what --observe prints). */
export async function observe(q) {
  const pol = await q(POLICY_SQL);
  const oldFn = await q(OLD_FN_SQL);
  const newFn = await q(NEW_FN_SQL);
  const policyText = pol.length === 1 ? `${pol[0].cmd}|${pol[0].perm}|${pol[0].roles}|${canonicalSql(pol[0].q).replace(/\bpublic\./g, "")}` : "none";
  return {
    policyCount: pol.length, policyText, policyMd5: md5(policyText),
    oldFnCount: oldFn.length, oldFnMd5: md5(oldFn.map((r) => canonicalSql(r.d) + r.sd + r.cfg + r.acl).join("|")),
    newFnCount: newFn.length, newFn: newFn[0] ?? null,
  };
}

/** Everything the migration must NOT change, as md5s. The policy set excludes transactions_read_policy and the function set excludes the new function. */
async function unrelatedFingerprint(q) {
  return {
    otherFunctions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname <> '${NEW_FUNCTION}' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    functionProps: (await q(`select md5(string_agg(p.oid::regprocedure::text||p.prosecdef::text||p.provolatile::text||coalesce(p.proconfig::text,'')||pg_get_userbyid(p.proowner), ',' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> '${NEW_FUNCTION}'`))[0].h,
    functionExec: (await q(`select md5(string_agg(p.oid::regprocedure::text||':'||r.rolname, ',' order by p.oid::regprocedure::text, r.rolname)) h from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r(rolname) where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname <> '${NEW_FUNCTION}' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`))[0].h,
    policies: (await q("select md5(string_agg(schemaname||tablename||policyname||cmd||permissive||array_to_string(roles,',')||coalesce(qual,'')||coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage') and not (schemaname = 'public' and tablename = 'transactions' and policyname = 'transactions_read_policy')"))[0].h,
    policyNames: (await q("select md5(string_agg(schemaname||tablename||policyname, ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    tablePrivs: (await q("select md5(string_agg(c.relname||':'||r.rolname||':'||p, ',' order by c.relname, r.rolname, p)) h from pg_class c cross join unnest(array['anon','authenticated','service_role']) r(rolname) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.rolname, c.oid, p)"))[0].h,
    columns: (await q("select md5(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public'"))[0].h,
    constraints: (await q("select md5(string_agg(c.relname||k.conname||pg_get_constraintdef(k.oid), ',' order by c.relname, k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype <> 'n'"))[0].h,
    triggers: (await q("select coalesce(md5(string_agg(c.relname||t.tgname||pg_get_triggerdef(t.oid)||t.tgenabled::text, ',' order by c.relname, t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"))[0].h,
    rls: (await q("select md5(string_agg(relname||relrowsecurity::text||relforcerowsecurity::text, ',' order by relname)) h from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')"))[0].h,
    buckets: (await q("select coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)),'none') h from storage.buckets b"))[0].h,
    profiles: (await q("select coalesce(md5(string_agg(md5(p::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    capabilities: (await q("select coalesce(md5(string_agg(md5(c::text), ',' order by c.id::text)), 'none') h from public.caterlink_station_capabilities c"))[0].h,
    transactions: (await q("select count(*)::text h from public.transactions"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
  };
}
const historyFingerprint = async (q) => (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h;

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the visibility migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  const obs = await observe(q);
  if (obs.newFnCount !== 0) fail("the new visibility function already exists: it has been applied already or the schema is not the reviewed one");
  if (obs.policyCount !== 1) fail("transactions_read_policy is not present exactly once");
  if (!obs.policyText.includes(OLD_FUNCTION)) fail("transactions_read_policy does not use the station-membership function: it has been changed already or the schema is not the reviewed one");
  if (obs.oldFnCount !== 1) fail("the station-membership function is not present exactly once");
  if (ctx.hashes) {
    if (obs.policyMd5 !== ctx.hashes.policyMd5) fail("transactions_read_policy differs from the observed pre-state");
    if (obs.oldFnMd5 !== ctx.hashes.oldFunctionMd5) fail("the station-membership function differs from the observed pre-state");
  }
  return obs;
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== (ctx.postCount ?? POST_COUNT) || mig[mig.length - 1]?.version !== (ctx.postLast ?? POST_LAST)) fail(`history is not ${ctx.postCount ?? POST_COUNT} ending ${ctx.postLast ?? POST_LAST} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  for (const m of MIGRATIONS) if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) fail(`${m.version} is not recorded exactly once with its name`);
  const obs = await observe(q);
  if (obs.policyCount !== 1 || !obs.policyText.includes(NEW_FUNCTION) || obs.policyText.includes(OLD_FUNCTION)) fail("transactions_read_policy is not the least-privilege policy");
  if (!/^r\|true\|authenticated\|/.test(obs.policyText)) fail("transactions_read_policy is not a permissive SELECT policy for authenticated only");
  for (const keep of ["has_active_role_for_aoc('caterlink_management'", "has_active_role_for_aoc('operation_manager'", "has_active_role_for_aoc('main_enforcement'", "created_by = auth.uid()", "service_role"]) if (!obs.policyText.includes(keep)) fail(`the policy lost its legitimate branch: ${keep}`);
  const f = obs.newFn;
  if (!f || !f.sd || f.vol !== "s" || !/search_path=public/.test(f.cfg) || f.owner !== "postgres") fail("the new function is not SECURITY DEFINER / STABLE with a fixed search_path owned by postgres");
  if (/=X\//.test(f.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail("the new function is executable by PUBLIC/anon");
  if (!/authenticated=X\//.test(f.acl) || !/service_role=X\//.test(f.acl)) fail("the new function is not executable by authenticated and service_role");
  if (obs.oldFnCount !== 1) fail("the station-membership function was dropped (it must remain, unused)");
  return { history: mig.length, last: mig[mig.length - 1].version, obs };
}

/**
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, onSnapshot?, expectedProbes? }
 * Personas (manifest labels): aso & profiling_aso (PEN), aso-jhb (JHB), aso-kul (KUL - MAA), aso-kch-receipt (KCH), aso-bki-receipt (BKI),
 * aso-no-caterlink, caterlink_management, operation_manager, caterlink-driver (creator of the fixture movements), caterlink-vendor, neg-pending-profile.
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
  log("hosted pre-state verified exactly (history, transactions_read_policy, the station-membership function); the new function is absent");
  const pre = await unrelatedFingerprint(q);
  const preHistory = await historyFingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    previousPolicy: preObs.policyText,
    previousStationMembershipFunction: (await q(OLD_FN_SQL))[0]?.d,
    fingerprints: { unrelated: pre, history: preHistory, policyMd5: preObs.policyMd5, oldFnMd5: preObs.oldFnMd5 },
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

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      // ---- fixtures (inside this transaction; rolled back with it): three synthetic movements by a driver identity, and a seal on the first
      const aoc = (await q("select id from public.aocs where code = 'MY'"))[0]?.id ?? fail("no MY AOC");
      const stationId = async (code) => (await q("select id from public.org_stations where code = $1 and is_active", [code]))[0]?.id ?? fail(`no active station ${code}`);
      await client.query("set local session_replication_role = replica");
      const creator = acct("caterlink-driver");
      const mk = async (n, origin, dest) => (await client.query(
        `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, hub_destination, flight_number, created_by)
         values ($1,$2,'OUTBOUND','VISIBILITY-VEH','visibility probe','VISIBILITY-DRV','VISIBILITY-SEAL','CREATED','AIRCRAFT',$3,$4,$5,'AK9001',$6) returning id`,
        [`VISPROBE-${n}-${Date.now()}`, aoc, await stationId(origin), await stationId(dest), dest === "KUL - MAA" ? null : dest, creator])).rows[0].id;
      const T1 = await mk(1, "KUL - MAA", "PEN");
      const T2 = await mk(2, "PEN", "KCH");
      const T3 = await mk(3, "JHB", "KUL - MAA");
      await client.query("insert into public.seals (transaction_id, seal_number, seal_type, seal_color) values ($1,'VISIBILITY-SEAL','TRUCK_SEAL','BLUE')", [T1]);
      await client.query("set local session_replication_role = origin");
      const reads = (label, id) => asUser(label, async () => (await client.query("select count(*)::int n from public.transactions where id = $1", [id])).rows[0].n === 1);
      const sealReads = (label) => asUser(label, async () => (await client.query("select count(*)::int n from public.seals where transaction_id = $1", [T1])).rows[0].n === 1);
      const matrix = async () => {
        const out = {};
        const labels = ["aso", "profiling_aso", "aso-jhb", "aso-kul", "aso-kch-receipt", "aso-bki-receipt", "aso-no-caterlink", "caterlink_management", "operation_manager", "caterlink-driver", "caterlink-vendor", "neg-pending-profile"];
        for (const [name, id] of [["T1", T1], ["T2", T2], ["T3", T3]]) for (const l of labels) out[`${name}:${l}`] = await reads(l, id);
        out.sealsProfiling = await sealReads("profiling_aso");
        out.sealsPen = await sealReads("aso");
        out.anon = await asRole(null, "anon", async () => (await client.query("select count(*)::int n from public.transactions where id = $1", [T1])).rows[0].n === 1).catch(() => "denied");
        return out;
      };

      // ---- the defect on the pre-state: station membership alone grants read
      const before = await matrix();
      if (ctx.hashes) {
        if (before["T1:profiling_aso"] !== true) fail("the defect was not reproduced on the pre-state: profiling_aso at PEN could not read a PEN-destined movement");
        if (before["T1:aso"] !== true) fail("pre-state sanity failed: aso at PEN could not read a PEN-destined movement");
      }
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      const hist = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
      if (hist.n !== ctx.preCount + files.length || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} ending ${files[files.length - 1].version} (${hist.n} / ${hist.v})`);
      probe(`migration history is ${hist.n} ending ${hist.v}, the visibility version recorded once; ${ctx.hashes ? "the defect was reproduced first (profiling_aso read a PEN-destined movement)" : "pre-change profiling_aso read: " + before["T1:profiling_aso"]}`);

      // ---- structure
      const post = await observe(q);
      if (post.policyMd5 === preObs.policyMd5) fail("transactions_read_policy did not change");
      if (post.policyCount !== 1 || !post.policyText.includes(NEW_FUNCTION) || post.policyText.includes(OLD_FUNCTION)) fail("transactions_read_policy is not the least-privilege policy");
      if (!/^r\|true\|authenticated\|/.test(post.policyText)) fail("transactions_read_policy is not a permissive SELECT policy for authenticated only");
      for (const keep of ["has_active_role_for_aoc('caterlink_management'", "has_active_role_for_aoc('operation_manager'", "has_active_role_for_aoc('main_enforcement'", "created_by = auth.uid()", "service_role"]) if (!post.policyText.includes(keep)) fail(`the policy lost its legitimate branch: ${keep}`);
      probe("transactions_read_policy: still one permissive SELECT policy for authenticated; Management / Operation Manager / Main Enforcement / creator / service_role branches kept; the station-membership branch replaced");
      const nf = post.newFn;
      if (!nf || !nf.sd || nf.vol !== "s" || !/search_path=public/.test(nf.cfg) || nf.owner !== "postgres") fail("the new function's security properties are wrong");
      if (/=X\//.test(nf.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail("the new function is executable by PUBLIC/anon");
      probe("new function: SECURITY DEFINER, STABLE, search_path=public, owned by postgres, EXECUTE only for authenticated, service_role (and the owner)");
      if (post.oldFnMd5 !== preObs.oldFnMd5) fail("the old station-membership function changed (it must stay untouched and unused)");
      probe("the old station-membership function is untouched (and unused by the policy)");
      const mid = await unrelatedFingerprint(q);
      for (const k of Object.keys(pre)) if (k !== "transactions" && mid[k] !== pre[k]) fail(`the migration changed something it must not (${k})`);
      probe("every unrelated fingerprint is unchanged (other function bodies, properties and EXECUTE grants, all other policies, table privileges, columns, constraints, triggers, RLS, storage buckets, profiles, assignments, station capabilities, movements, Auth users)");

      // ---- behaviour after the change, with real roles
      const after = await matrix();
      const expectRead = {
        T1: ["aso-kul", "aso", "caterlink_management", "operation_manager", "caterlink-driver"],
        T2: ["aso", "aso-kch-receipt", "caterlink_management", "operation_manager", "caterlink-driver"],
        T3: ["aso-jhb", "aso-kul", "caterlink_management", "operation_manager", "caterlink-driver"],
      };
      const labels = ["aso", "profiling_aso", "aso-jhb", "aso-kul", "aso-kch-receipt", "aso-bki-receipt", "aso-no-caterlink", "caterlink_management", "operation_manager", "caterlink-driver", "caterlink-vendor", "neg-pending-profile"];
      const wrong = [];
      for (const [name, allowed] of Object.entries(expectRead)) for (const l of labels) if (after[`${name}:${l}`] !== allowed.includes(l)) wrong.push(`${name}:${l}=${after[`${name}:${l}`]}`);
      if (wrong.length) fail(`the access matrix is not as designed: ${wrong.join(", ")}`);
      probe("profiling_aso (PEN) can no longer read a PEN-destined or PEN-origin movement");
      probe("aso (PEN) reads the PEN-destined movement (receipt capability) and the PEN-origin movement (scan capability)");
      probe("aso-kul (KUL - MAA) reads its own outgoing movement (create capability) and the movement received at KUL - MAA");
      probe("aso-jhb (JHB) reads the JHB-origin movement (scan capability) and not the PEN movements (cross-station isolation)");
      probe("aso-kch-receipt reads only the KCH-destined movement; aso-bki-receipt (BKI) and aso-no-caterlink read none");
      probe("caterlink_management and operation_manager read all three movements");
      probe("caterlink-driver reads the movements it created; caterlink-vendor reads none (cross-party isolation)");
      probe("a pending profile with an active assignment reads none");
      if (after.sealsProfiling !== false || after.sealsPen !== true) fail(`seals did not tighten with the movement (${after.sealsProfiling}/${after.sealsPen})`);
      probe("the seals of a movement follow its visibility (aso at PEN reads them, profiling_aso no longer does)");
      if (after.anon === true) fail("anon can read a movement");
      probe("anon reads no movement");
      // the creator-only and management branches work for rows the capability model does not cover
      const created = await asUser("caterlink-driver", async () => (await client.query("select count(*)::int n from public.transactions where id = any($1::uuid[])", [[T1, T2, T3]])).rows[0].n);
      if (created !== 3) fail(`the creator branch broke (${created})`);
      probe("the creator branch is intact: the Driver reads all three movements it created");
      const sc = await asUser("aso", async () => (await client.query("select public.can_user_scan_caterlink('PEN') a, public.can_user_confirm_caterlink_receipt('PEN') b")).rows[0]);
      if (typeof sc === "string" || sc.a !== true || sc.b !== true) fail(`the canonical capability functions changed behaviour (${JSON.stringify(sc)})`);
      probe("the canonical capability functions are unchanged for aso at PEN (scan and receipt both true)");

      // the probe fixtures must never outlive the probes: remove exactly them before the commit (the dry run rolls back anyway)
      await client.query("set local session_replication_role = replica");
      await client.query("delete from public.seals where transaction_id = any($1::uuid[])", [[T1, T2, T3]]);
      const removed = await client.query("delete from public.transactions where id = any($1::uuid[])", [[T1, T2, T3]]);
      await client.query("set local session_replication_role = origin");
      if (removed.rowCount !== 3) fail(`the probe fixtures were not removed exactly (${removed.rowCount} of 3)`);
      if ((await q("select count(*)::int n from public.transactions where transaction_number like 'VISPROBE-%'"))[0].n !== 0) fail("a probe movement remains");
      if ((await q("select count(*)::text h from public.transactions"))[0].h !== pre.transactions) fail("the movement count differs from the pre-state after the probes");
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
  if (obsAfter.policyMd5 !== preObs.policyMd5 || obsAfter.oldFnMd5 !== preObs.oldFnMd5 || obsAfter.newFnCount !== 0) fail("the policy or functions changed after the rolled-back dry run");
  if ((await historyFingerprint(q)) !== preHistory) fail("migration history changed after the rolled-back dry run");
  log(`staging is unchanged after the dry-run rollback (history ${ctx.preCount}, policy, functions, every fingerprint)`);
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
        console.log(JSON.stringify({ policyMd5: o.policyMd5, oldFunctionMd5: o.oldFnMd5, policyCount: o.policyCount, newFunctionCount: o.newFnCount }, null, 1));
      } else {
        const v = await verifyApplied(rq);
        log(`VERIFIED: history ${v.history} ending ${v.last}; transactions_read_policy is the least-privilege policy; the new function has the reviewed properties`);
      }
      await client.query("rollback");
    } finally { await client.end().catch(() => {}); }
    return;
  }
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`CaterLink visibility migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-caterlink-visibility-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (previous policy, previous function, fingerprints) written and re-authenticated (${path.basename(snap)})`);
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
