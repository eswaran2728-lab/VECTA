#!/usr/bin/env node
// Applies ONLY the frozen "DSE leave scoped to station AND team, duty-zone writes Operation Manager only" migration to the approved staging project.
// PREPARED, NOT EXECUTED unless --live.
//   20261128000001_scope_dse_leave_and_operation_manager_zone_writes
//     -- adds canon_dse_of_team(); re-creates the absence_notices SELECT / UPDATE policies on it; re-creates the duty_zones INSERT / UPDATE / DELETE policies
//        on the Operation Manager only. The SELECT policy of duty_zones (check-in reads), the secure leave review RPCs and the roster RPCs are not touched.
// Same shape as the earlier guarded runners: exact branch / head / ancestry / clean tree, verified-TLS connection, authenticated fresh backup (<6 h, outside the
// repository), frozen SHA-256, statement allow-list, hosted pre-state fingerprints, a transactional dry run with real-role probes (including the defect reproduced on
// the pre-state, another team at the same station, another hub, and ordinary staff still reading zones) that is rolled back and proven to leave staging unchanged,
// and a --live pass only with the exact phrase. Prints names and counts only.
//
//   node --env-file=.env.local scripts/staging/apply-leave-zone-scope-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-leave-zone-scope-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
//   node --env-file=.env.local scripts/staging/apply-leave-zone-scope-migration.mjs --verify-applied                                            (read-only)
//   node --env-file=.env.local scripts/staging/apply-leave-zone-scope-migration.mjs --observe                                                   (read-only pre-state)
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
  { version: "20261128000001", name: "scope_dse_leave_and_operation_manager_zone_writes", sha256: "e7b8f33cc55e6fd8152d18edb4d2fa2f62837f8fad490c0ae7b7300fb608e576" },
];
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The pushed baseline carrying the certified rollout; HEAD must descend from it. */
export const PUSHED_BASE = "4f792074c721d81aa48503ee3b6999042dbdd7bd";
export const PRE_COUNT = 101;
export const LAST_PRE = "20261127000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;
export const NEW_FUNCTION = "canon_dse_of_team";
export const ABSENCE_POLICIES = ["absence_notices_select_elevated", "absence_notices_dse_management_update"];
export const ZONE_WRITE_POLICIES = ["duty_zones_admin_insert", "duty_zones_admin_update", "duty_zones_admin_delete"];

/** Frozen from a read-only observation of the approved staging project (run `--observe`); any difference aborts before anything is written. */
export const PRE_STATE = {
  absenceMd5: "7d848c94d30c12bf0cc90e3a45d1d459",
  zoneWriteMd5: "3c0e4d7c7a3bb96ec33b821be294665b",
  zoneReadMd5: "25a7f710620715cf888b3073a03c4076",
  adminFnMd5: "ebef3c8b24360171dea94bcf809c46c0",
};
export const EXPECTED_PROBES = 0;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const md5 = (t) => crypto.createHash("md5").update(String(t ?? "")).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^create or replace function public\.canon_dse_of_team\(p_station text, p_team text\) returns boolean language sql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.canon_dse_of_team\(text, text\) from public, anon$/,
  /^grant execute on function public\.canon_dse_of_team\(text, text\) to authenticated, service_role$/,
  /^drop policy absence_notices_select_elevated on public\.absence_notices$/,
  /^create policy absence_notices_select_elevated on public\.absence_notices for select to authenticated using \(.+\)$/,
  /^drop policy absence_notices_dse_management_update on public\.absence_notices$/,
  /^create policy absence_notices_dse_management_update on public\.absence_notices for update to authenticated using \(.+\) with check \(.+\)$/,
  /^drop policy duty_zones_admin_insert on public\.duty_zones$/,
  /^create policy duty_zones_admin_insert on public\.duty_zones for insert to authenticated with check \(.+\)$/,
  /^drop policy duty_zones_admin_update on public\.duty_zones$/,
  /^create policy duty_zones_admin_update on public\.duty_zones for update to authenticated using \(.+\) with check \(.+\)$/,
  /^drop policy duty_zones_admin_delete on public\.duty_zones$/,
  /^create policy duty_zones_admin_delete on public\.duty_zones for delete to authenticated using \(.+\)$/,
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
  if (statements.length !== ALLOWED_STATEMENTS.length) return `expected exactly ${ALLOWED_STATEMENTS.length} statements, found ${statements.length}`;
  const policy = (name) => statements.find((s) => s.startsWith(`create policy ${name} `)) ?? "";
  for (const n of ABSENCE_POLICIES) {
    const p = policy(n);
    if (!p.includes(NEW_FUNCTION) || !p.includes("canon_has_role(array['operation_manager'") || p.includes("canon_has_role_at_station")) return `${n} does not use the team-scoped DSE function`;
  }
  if (!policy("absence_notices_select_elevated").includes("'main_enforcement'")) return "absence_notices_select_elevated lost Main Enforcement's read authority";
  if (policy("absence_notices_dse_management_update").includes("main_enforcement")) return "absence_notices_dse_management_update grants Main Enforcement update";
  for (const n of ZONE_WRITE_POLICIES) {
    const p = policy(n);
    if (!p.includes("canon_has_role(array['operation_manager'])") || p.includes("canon_can_admin_station") || /dse|hub_se/.test(p)) return `${n} is not Operation-Manager-only`;
  }
  if (/duty_zones_scoped_read/.test(code)) return "the duty_zones read policy must not be touched";
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
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `leave-zone-scope-${process.pid}.log`), l + "\n"); };

const POLICY_SQL = (table, names) => `select p.polname, p.polcmd cmd, p.polpermissive perm, (select string_agg(rolname, ',' order by rolname) from pg_roles r where r.oid = any(p.polroles)) roles, coalesce(pg_get_expr(p.polqual, p.polrelid), '') q, coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') wc from pg_policy p where p.polrelid = 'public.${table}'::regclass and p.polname = any(array[${names.map((n) => `'${n}'`).join(",")}]) order by p.polname`;
const NEW_FN_SQL = `select pg_get_functiondef(p.oid) d, p.prosecdef sd, p.provolatile vol, coalesce(p.proconfig::text,'') cfg, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${NEW_FUNCTION}'`;
const ADMIN_FN_SQL = "select pg_get_functiondef(p.oid) d, p.prosecdef sd, coalesce(p.proconfig::text,'') cfg, coalesce(p.proacl::text,'') acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'canon_can_admin_station'";
const policyText = (rows) => rows.map((r) => `${r.polname}|${r.cmd}|${r.perm}|${r.roles}|${canonicalSql(r.q).replace(/\bpublic\./g, "")}|${canonicalSql(r.wc).replace(/\bpublic\./g, "")}`).join("\n");

/** The observations the frozen PRE_STATE is made of (also what --observe prints). */
export async function observe(q) {
  const abs = await q(POLICY_SQL("absence_notices", ABSENCE_POLICIES));
  const zw = await q(POLICY_SQL("duty_zones", ZONE_WRITE_POLICIES));
  const zr = await q(POLICY_SQL("duty_zones", ["duty_zones_scoped_read"]));
  const fn = await q(NEW_FN_SQL);
  const adm = await q(ADMIN_FN_SQL);
  const absText = policyText(abs), zwText = policyText(zw), zrText = policyText(zr);
  return {
    absenceCount: abs.length, absenceText: absText, absenceMd5: md5(absText),
    zoneWriteCount: zw.length, zoneWriteText: zwText, zoneWriteMd5: md5(zwText),
    zoneReadCount: zr.length, zoneReadMd5: md5(zrText),
    newFnCount: fn.length, newFn: fn[0] ?? null,
    adminFnCount: adm.length, adminFnMd5: md5(adm.map((r) => canonicalSql(r.d) + r.sd + r.cfg + r.acl).join("|")),
  };
}

/** Everything the migration must NOT change, as md5s. The policy set excludes the five re-created policies; the function set excludes the new function. */
async function unrelatedFingerprint(q) {
  const names = [...ABSENCE_POLICIES, ...ZONE_WRITE_POLICIES].map((n) => `'${n}'`).join(",");
  return {
    otherFunctions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname <> '${NEW_FUNCTION}' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    functionProps: (await q(`select md5(string_agg(p.oid::regprocedure::text||p.prosecdef::text||p.provolatile::text||coalesce(p.proconfig::text,'')||pg_get_userbyid(p.proowner), ',' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> '${NEW_FUNCTION}'`))[0].h,
    functionExec: (await q(`select md5(string_agg(p.oid::regprocedure::text||':'||r.rolname, ',' order by p.oid::regprocedure::text, r.rolname)) h from pg_proc p cross join unnest(array['anon','authenticated','service_role']) r(rolname) where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname <> '${NEW_FUNCTION}' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`))[0].h,
    otherPolicies: (await q(`select md5(string_agg(schemaname||tablename||policyname||cmd||permissive||array_to_string(roles,',')||coalesce(qual,'')||coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage') and not (schemaname = 'public' and policyname in (${names}))`))[0].h,
    policyNames: (await q(`select md5(string_agg(schemaname||tablename||policyname||cmd, ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')`))[0].h,
    tablePrivs: (await q("select md5(string_agg(c.relname||':'||r.rolname||':'||p, ',' order by c.relname, r.rolname, p)) h from pg_class c cross join unnest(array['anon','authenticated','service_role']) r(rolname) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.rolname, c.oid, p)"))[0].h,
    columns: (await q("select md5(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public'"))[0].h,
    constraints: (await q("select md5(string_agg(c.relname||k.conname||pg_get_constraintdef(k.oid), ',' order by c.relname, k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype <> 'n'"))[0].h,
    triggers: (await q("select coalesce(md5(string_agg(c.relname||t.tgname||pg_get_triggerdef(t.oid)||t.tgenabled::text, ',' order by c.relname, t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"))[0].h,
    rls: (await q("select md5(string_agg(relname||relrowsecurity::text||relforcerowsecurity::text, ',' order by relname)) h from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')"))[0].h,
    buckets: (await q("select coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)),'none') h from storage.buckets b"))[0].h,
    profiles: (await q("select coalesce(md5(string_agg(md5(p::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    roleAssignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    formAssignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.report_form_assignments a"))[0].h,
    absenceRows: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.absence_notices a"))[0].h,
    zoneRows: (await q("select coalesce(md5(string_agg(md5(z::text), ',' order by z.id::text)), 'none') h from public.duty_zones z"))[0].h,
    rosterRows: (await q("select coalesce(md5(string_agg(md5(r::text), ',' order by r.station, r.team, r.roster_date)), 'none') h from public.team_rosters r"))[0].h,
    reportRows: (await q("select (select count(*) from public.report_sec013)::text||'/'||(select count(*) from public.report_sec014)::text||'/'||(select count(*) from public.report_sec016)::text||'/'||(select count(*) from public.report_sec018)::text||'/'||(select count(*) from public.report_sec029)::text||'/'||(select count(*) from public.report_sec033)::text||'/'||(select count(*) from public.offload_records)::text h"))[0].h,
    transactions: (await q("select count(*)::text h from public.transactions"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
  };
}
const historyFingerprint = async (q) => (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h;

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the leave/zone scope migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  const obs = await observe(q);
  if (obs.newFnCount !== 0) fail("canon_dse_of_team already exists: it has been applied already or the schema is not the reviewed one");
  if (obs.absenceCount !== 2 || obs.zoneWriteCount !== 3 || obs.zoneReadCount !== 1) fail("the absence_notices / duty_zones policies are not the reviewed set");
  if (!obs.absenceText.includes("canon_has_role_at_station") || !obs.zoneWriteText.includes("canon_can_admin_station")) fail("the policies already differ from the reviewed pre-state");
  if (obs.adminFnCount !== 1) fail("canon_can_admin_station is not present exactly once");
  if (ctx.hashes) {
    if (obs.absenceMd5 !== ctx.hashes.absenceMd5) fail("the absence_notices policies differ from the observed pre-state");
    if (obs.zoneWriteMd5 !== ctx.hashes.zoneWriteMd5) fail("the duty_zones write policies differ from the observed pre-state");
    if (obs.zoneReadMd5 !== ctx.hashes.zoneReadMd5) fail("the duty_zones read policy differs from the observed pre-state");
    if (obs.adminFnMd5 !== ctx.hashes.adminFnMd5) fail("canon_can_admin_station differs from the observed pre-state");
  }
  return obs;
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== (ctx.postCount ?? POST_COUNT) || mig[mig.length - 1]?.version !== (ctx.postLast ?? POST_LAST)) fail(`history is not ${ctx.postCount ?? POST_COUNT} ending ${ctx.postLast ?? POST_LAST} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  for (const m of MIGRATIONS) if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) fail(`${m.version} is not recorded exactly once with its name`);
  const obs = await observe(q);
  if (obs.absenceCount !== 2 || !obs.absenceText.includes(NEW_FUNCTION) || obs.absenceText.includes("canon_has_role_at_station")) fail("the absence_notices policies are not team-scoped for DSE");
  if (!obs.absenceText.includes("'main_enforcement'")) fail("Main Enforcement lost its read authority");
  if (obs.zoneWriteCount !== 3 || obs.zoneWriteText.includes("canon_can_admin_station") || /dse|hub_se/.test(obs.zoneWriteText)) fail("the duty_zones write policies are not Operation-Manager-only");
  if (!obs.zoneWriteText.includes("operation_manager")) fail("the duty_zones write policies do not name the Operation Manager");
  if (obs.zoneReadCount !== 1) fail("the duty_zones read policy is missing");
  const f = obs.newFn;
  if (!f || !f.sd || f.vol !== "s" || !/search_path=public/.test(f.cfg) || f.owner !== "postgres") fail("canon_dse_of_team is not SECURITY DEFINER / STABLE with a fixed search_path owned by postgres");
  if (/=X\//.test(f.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail("canon_dse_of_team is executable by PUBLIC/anon");
  if (!/authenticated=X\//.test(f.acl) || !/service_role=X\//.test(f.acl)) fail("canon_dse_of_team is not executable by authenticated and service_role");
  return { history: mig.length, last: mig[mig.length - 1].version, obs };
}

/**
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, onSnapshot?, expectedProbes? }
 * Personas (manifest labels): dse (KUL - MAA / ALPHA), hub_se (northern hub: PEN ...), operation_manager, main_enforcement, so-kul, sso-kul, aso-kul (KUL - MAA / ALPHA),
 * aso (PEN / ALPHA), aso-jhb (JHB).
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
  log("hosted pre-state verified exactly (history, the five policies, the zone read policy, canon_can_admin_station); canon_dse_of_team is absent");
  const pre = await unrelatedFingerprint(q);
  const preHistory = await historyFingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    previousAbsencePolicies: preObs.absenceText,
    previousZoneWritePolicies: preObs.zoneWriteText,
    fingerprints: { unrelated: pre, history: preHistory, absenceMd5: preObs.absenceMd5, zoneWriteMd5: preObs.zoneWriteMd5, zoneReadMd5: preObs.zoneReadMd5, adminFnMd5: preObs.adminFnMd5 },
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
      // ---- fixtures (inside this transaction; removed before it ends): five leave notices and one zone
      const TAG = `PROBE-${Date.now()}`;
      await client.query("set local session_replication_role = replica");
      const mkNotice = async (userLabel, station, team) => (await client.query(
        `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, remarks, leave_type, start_date, end_date, approval_status, status)
         values ($1, $2, 'ASO', $3, $4, current_date + 30, now(), $5, 'annual', current_date + 30, current_date + 31, 'pending', 'green') returning id`,
        [acct(userLabel), `${TAG} ${userLabel}`, station, team, TAG])).rows[0].id;
      const N1 = await mkNotice("aso-kul", "KUL - MAA", "ALPHA"); // the DSE's own station AND team
      const N2 = await mkNotice("sso-kul", "KUL - MAA", "BRAVO"); // another team at the same station
      const N3 = await mkNotice("aso", "PEN", "ALPHA"); // another station (and hub)
      const N4 = await mkNotice("aso-kul", "KUL - MAA", null); // station but no team
      const N5 = await mkNotice("aso-kul", null, null); // neither station nor team
      const NOTICES = { N1, N2, N3, N4, N5 };
      const zoneFx = (await client.query("insert into public.duty_zones (station, code, name, polygon, center_lat, center_lng) values ('KUL - MAA', $1, $2, '[]'::jsonb, 3.1, 101.7) returning id", [`ZP${Date.now() % 100000}`, `${TAG} zone`])).rows[0].id;
      await client.query("set local session_replication_role = origin");

      const labels = ["dse", "hub_se", "operation_manager", "main_enforcement", "so-kul", "sso-kul", "aso-kul", "aso", "aso-jhb"];
      const readMatrix = async () => {
        const out = {};
        for (const l of labels) {
          const r = await asUser(l, async () => (await client.query("select id from public.absence_notices where id = any($1::uuid[])", [Object.values(NOTICES)])).rows.map((x) => x.id));
          out[l] = typeof r === "string" ? r : Object.entries(NOTICES).filter(([, id]) => r.includes(id)).map(([k]) => k).join(",");
        }
        return out;
      };
      const updateMatrix = async () => {
        const out = {};
        for (const l of ["dse", "hub_se", "operation_manager", "main_enforcement", "so-kul"]) {
          out[l] = {};
          for (const [k, id] of Object.entries(NOTICES)) {
            const r = await asUser(l, async () => (await client.query("update public.absence_notices set remarks = remarks where id = $1", [id])).rowCount);
            out[l][k] = r;
          }
        }
        return out;
      };
      const zoneWrites = async () => {
        const out = {};
        const attempts = [["dse", "KUL - MAA"], ["hub_se", "PEN"], ["aso-kul", "KUL - MAA"], ["so-kul", "KUL - MAA"], ["aso", "PEN"], ["main_enforcement", "KUL - MAA"], ["operation_manager", "KUL - MAA"]];
        for (const [l, station] of attempts) {
          const ins = await asUser(l, async () => (await client.query("insert into public.duty_zones (station, code, name, polygon, center_lat, center_lng) values ($1, $2, $3, '[]'::jsonb, 3.1, 101.7) returning id", [station, `ZW${Date.now() % 100000}${l.length}`, `${TAG} insert ${l}`])).rowCount);
          const upd = await asUser(l, async () => (await client.query("update public.duty_zones set name = name where id = $1", [zoneFx])).rowCount);
          const del = await asUser(l, async () => (await client.query("delete from public.duty_zones where id = $1", [zoneFx])).rowCount);
          // an RLS-denied INSERT raises; a denied UPDATE / DELETE silently matches no row
          const norm = (n) => (typeof n === "string" || n === 0 ? "denied" : n);
          out[l] = { insert: norm(ins), update: norm(upd), delete: norm(del) };
        }
        return out;
      };
      const zoneReads = async () => {
        const out = {};
        for (const l of ["aso-kul", "so-kul", "dse", "aso", "aso-jhb", "hub_se", "operation_manager"]) {
          const r = await asUser(l, async () => (await client.query("select (select count(*)::int from public.duty_zones where station = 'KUL - MAA' and id = $1) fx, (select count(*)::int from public.duty_zones where station = 'KUL - MAA') kul, (select count(*)::int from public.duty_zones where station = 'PEN') pen", [zoneFx])).rows[0]);
          out[l] = typeof r === "string" ? r : `${r.fx}/${r.kul}/${r.pen}`;
        }
        return out;
      };
      const rosterProbe = async () => {
        const can = async (l, s, t) => asUser(l, async () => (await client.query("select public.can_manage_roster_secure($1, $2) ok", [s, t])).rows[0].ok);
        const write = async (l, s, t) => {
          const r = await asUser(l, async () => { await client.query("select public.upsert_roster_cell_secure($1::text, $2::text, current_date + 40, 'OFF'::text, null::time, null::time, $3::text)", [s, t, TAG]); return "written"; });
          return typeof r === "string" && r.startsWith("ERR") ? "denied" : r;
        };
        return {
          hubSeOwnHub: [await can("hub_se", "PEN", "ALPHA"), await write("hub_se", "PEN", "ALPHA")],
          hubSeAnotherHub: [await can("hub_se", "JHB", "ALPHA"), await write("hub_se", "JHB", "ALPHA"), await can("hub_se", "KUL - MAA", "ALPHA")],
          dseOwnTeam: [await can("dse", "KUL - MAA", "ALPHA"), await write("dse", "KUL - MAA", "ALPHA")],
          dseOtherTeamSameStation: [await can("dse", "KUL - MAA", "BRAVO"), await write("dse", "KUL - MAA", "BRAVO")],
          dseOtherStation: [await can("dse", "PEN", "ALPHA"), await write("dse", "PEN", "ALPHA")],
          operationManager: [await can("operation_manager", "JHB", "BRAVO"), await write("operation_manager", "JHB", "BRAVO")],
          staff: [await can("aso", "PEN", "ALPHA"), await write("aso", "PEN", "ALPHA")],
        };
      };

      // ---- the pre-state: the defects reproduced, and what must not change
      const rBefore = await readMatrix();
      const uBefore = await updateMatrix();
      const zBefore = await zoneWrites();
      const zrBefore = await zoneReads();
      const rosterBefore = await rosterProbe();
      if (ctx.hashes) {
        if (rBefore.dse !== "N1,N2,N4") fail(`the leave defect was not reproduced on the pre-state: dse reads ${rBefore.dse} (expected N1,N2,N4: any team at the station)`);
        if (zBefore.dse.insert !== 1 || zBefore.hub_se.insert !== 1) fail(`the zone defect was not reproduced on the pre-state: dse insert ${zBefore.dse.insert}, hub_se insert ${zBefore.hub_se.insert}`);
      }

      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      const hist = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
      if (hist.n !== ctx.preCount + files.length || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} ending ${files[files.length - 1].version} (${hist.n} / ${hist.v})`);
      probe(`migration history is ${hist.n} ending ${hist.v}, the leave/zone scope version recorded once${ctx.hashes ? "; the defects were reproduced first (a DSE read another team's leave; a DSE and a Hub SE could write zones)" : ""}`);

      // ---- structure
      const post = await observe(q);
      if (post.absenceMd5 === preObs.absenceMd5 || post.zoneWriteMd5 === preObs.zoneWriteMd5) fail("a re-created policy set did not change");
      if (post.absenceCount !== 2 || !post.absenceText.includes(NEW_FUNCTION) || post.absenceText.includes("canon_has_role_at_station")) fail("the absence_notices policies are not team-scoped for DSE");
      for (const keep of ["'operation_manager'", "'main_enforcement'"]) if (!post.absenceText.includes(keep)) fail(`the absence_notices policies lost ${keep}`);
      if (post.zoneWriteCount !== 3 || post.zoneWriteText.includes("canon_can_admin_station") || /dse|hub_se/.test(post.zoneWriteText)) fail("the duty_zones write policies are not Operation-Manager-only");
      if (post.zoneReadMd5 !== preObs.zoneReadMd5) fail("the duty_zones read policy changed");
      if (post.adminFnMd5 !== preObs.adminFnMd5) fail("canon_can_admin_station changed (it must stay untouched)");
      const nf = post.newFn;
      if (!nf || !nf.sd || nf.vol !== "s" || !/search_path=public/.test(nf.cfg) || nf.owner !== "postgres") fail("canon_dse_of_team's security properties are wrong");
      if (/=X\//.test(nf.acl.replace(/(authenticated|service_role|postgres)=X\//g, ""))) fail("canon_dse_of_team is executable by PUBLIC/anon");
      probe("structure: five policies re-created (leave: DSE by station AND team, Operation Manager and Main Enforcement kept; zone writes: Operation Manager only); zone read policy and canon_can_admin_station untouched; the new function is SECURITY DEFINER, STABLE, fixed search_path, EXECUTE only for authenticated and service_role");
      const mid = await unrelatedFingerprint(q);
      // the probe fixtures are present right now, so the two row-level fingerprints they touch are compared after the fixtures are removed (below)
      for (const k of Object.keys(pre)) if (k !== "absenceRows" && k !== "zoneRows" && mid[k] !== pre[k]) fail(`the migration changed something it must not (${k})`);
      probe("every unrelated fingerprint is unchanged (other functions, properties and EXECUTE grants, all other policies, table privileges, columns, constraints, triggers, RLS, buckets, profiles, role assignments, form assignments, leave rows, zone rows, roster rows, report rows, movements, Auth users)");

      // ---- behaviour after the change, with real roles
      const rAfter = await readMatrix();
      const expectRead = { dse: "N1", hub_se: "", operation_manager: "N1,N2,N3,N4,N5", main_enforcement: "N1,N2,N3,N4,N5", "so-kul": "", "sso-kul": "N2", "aso-kul": "N1,N4,N5", aso: "N3", "aso-jhb": "" };
      const wrongRead = labels.filter((l) => rAfter[l] !== expectRead[l]).map((l) => `${l}=${rAfter[l]} (expected ${expectRead[l]})`);
      if (wrongRead.length) fail(`the leave read matrix is not as designed: ${wrongRead.join("; ")}`);
      probe("DSE reads only its own station AND team (N1): not another team at the same station (N2), not a notice with no team (N4) or no station (N5), not another station (N3)");
      probe("Operation Manager and Main Enforcement still read every notice; Hub SE, SO and another station's ASO read none of the others; each staff member still reads their own");
      const uAfter = await updateMatrix();
      const expectUpd = { dse: { N1: 1, N2: 0, N3: 0, N4: 0, N5: 0 }, hub_se: { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 }, operation_manager: { N1: 1, N2: 1, N3: 1, N4: 1, N5: 1 }, main_enforcement: { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 }, "so-kul": { N1: 0, N2: 0, N3: 0, N4: 0, N5: 0 } };
      if (JSON.stringify(uAfter) !== JSON.stringify(expectUpd)) fail(`the leave review (update) matrix is not as designed: ${JSON.stringify(uAfter)}`);
      probe("DSE may review (update) only its own team's notice; another team at the same station, another station and unscoped notices are refused; Operation Manager still updates all; Main Enforcement, Hub SE and SO cannot update through the table");
      const zAfter = await zoneWrites();
      const denied = { insert: "denied", update: "denied", delete: "denied" };
      const expectZone = { dse: denied, hub_se: denied, "aso-kul": denied, "so-kul": denied, aso: denied, main_enforcement: denied, operation_manager: { insert: 1, update: 1, delete: 1 } };
      if (JSON.stringify(zAfter) !== JSON.stringify(expectZone)) fail(`the zone write matrix is not as designed: ${JSON.stringify(zAfter)}`);
      probe("zone create, edit and delete: only the Operation Manager succeeds; a DSE of the station, a Hub SE of the hub, ordinary staff and Main Enforcement are refused");
      const zrAfter = await zoneReads();
      if (JSON.stringify(zrAfter) !== JSON.stringify(zrBefore)) fail(`zone reads changed: ${JSON.stringify(zrBefore)} -> ${JSON.stringify(zrAfter)}`);
      const [fx, kul] = String(zrAfter["aso-kul"]).split("/").map(Number);
      if (!(fx === 1 && kul >= 1)) fail(`ordinary staff at KUL - MAA no longer read the station's zones (${zrAfter["aso-kul"]})`);
      if (String(zrAfter.aso).split("/")[1] !== "0") fail(`an ASO at PEN reads KUL zones (${zrAfter.aso})`);
      probe("zone reads are byte-for-byte unchanged and check-in still works: ASO and SO at KUL - MAA read the station's zones, a PEN ASO reads none of KUL's, Operation Manager reads all");
      const rosterAfter = await rosterProbe();
      if (JSON.stringify(rosterAfter) !== JSON.stringify(rosterBefore)) fail(`roster authority changed: ${JSON.stringify(rosterBefore)} -> ${JSON.stringify(rosterAfter)}`);
      const R = rosterAfter;
      if (!(R.hubSeOwnHub[0] === true && R.hubSeOwnHub[1] === "written")) fail(`Hub SE cannot manage its own hub's roster (${JSON.stringify(R.hubSeOwnHub)})`);
      if (!(R.hubSeAnotherHub[0] === false && R.hubSeAnotherHub[1] === "denied" && R.hubSeAnotherHub[2] === false)) fail(`Hub SE reaches another hub (${JSON.stringify(R.hubSeAnotherHub)})`);
      if (!(R.dseOwnTeam[0] === true && R.dseOwnTeam[1] === "written")) fail(`DSE cannot manage its own team's roster (${JSON.stringify(R.dseOwnTeam)})`);
      if (!(R.dseOtherTeamSameStation[0] === false && R.dseOtherTeamSameStation[1] === "denied" && R.dseOtherStation[0] === false && R.dseOtherStation[1] === "denied")) fail("DSE reaches another team or station's roster");
      if (!(R.operationManager[0] === true && R.operationManager[1] === "written" && R.staff[0] === false && R.staff[1] === "denied")) fail("Operation Manager / ordinary staff roster authority is wrong");
      probe("roster authority is enforced by the database and unchanged: Hub SE manages stations of its assigned hub (PEN) and is refused JHB and KUL - MAA; DSE manages only its own team (ALPHA), not BRAVO at the same station or another station; Operation Manager manages any; ordinary staff none");

      // ---- remove exactly the fixtures before anything can commit
      await client.query("set local session_replication_role = replica");
      const rmN = await client.query("delete from public.absence_notices where id = any($1::uuid[]) and remarks = $2", [Object.values(NOTICES), TAG]);
      const rmZ = await client.query("delete from public.duty_zones where id = $1 and name = $2", [zoneFx, `${TAG} zone`]);
      const rmR = await client.query("delete from public.team_rosters where notes = $1", [TAG]);
      await client.query("set local session_replication_role = origin");
      if (rmN.rowCount !== 5 || rmZ.rowCount !== 1 || rmR.rowCount !== 0) fail(`the probe fixtures were not removed exactly (${rmN.rowCount} notices, ${rmZ.rowCount} zone, ${rmR.rowCount} roster rows)`);
      if ((await q("select count(*)::int n from public.absence_notices where remarks = $1", [TAG]))[0].n !== 0) fail("a probe notice remains");
      const cleaned = await unrelatedFingerprint(q);
      for (const k of Object.keys(pre)) if (cleaned[k] !== pre[k]) fail(`after the fixtures were removed, ${k} differs from the pre-state`);
      probe("the probe fixtures (five leave notices, one zone, no roster rows) were removed exactly and every row-level fingerprint equals the pre-state");

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
  if (obsAfter.absenceMd5 !== preObs.absenceMd5 || obsAfter.zoneWriteMd5 !== preObs.zoneWriteMd5 || obsAfter.newFnCount !== 0) fail("the policies or function changed after the rolled-back dry run");
  if ((await historyFingerprint(q)) !== preHistory) fail("migration history changed after the rolled-back dry run");
  log(`staging is unchanged after the dry-run rollback (history ${ctx.preCount}, the policies, the function set, every fingerprint)`);
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
        console.log(JSON.stringify({ absenceMd5: o.absenceMd5, zoneWriteMd5: o.zoneWriteMd5, zoneReadMd5: o.zoneReadMd5, adminFnMd5: o.adminFnMd5, absenceCount: o.absenceCount, zoneWriteCount: o.zoneWriteCount, newFunctionCount: o.newFnCount }, null, 1));
      } else {
        const v = await verifyApplied(rq);
        log(`VERIFIED: history ${v.history} ending ${v.last}; DSE leave is station AND team scoped (Operation Manager and Main Enforcement kept); zone writes are Operation-Manager-only; the zone read policy is unchanged`);
      }
      await client.query("rollback");
    } finally { await client.end().catch(() => {}); }
    return;
  }
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`Leave/zone scope migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-leave-zone-scope-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (previous policies, fingerprints) written and re-authenticated (${path.basename(snap)})`);
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
