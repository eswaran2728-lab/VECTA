#!/usr/bin/env node
// Applies ONLY the two frozen security-hardening migrations to the approved staging project. PREPARED, NOT EXECUTED unless --live.
//   20261118000004_revoke_excess_authenticated_grants   -- ACL only: removes TRUNCATE / TRIGGER / REFERENCES (and the unintended shift_handovers DELETE, write
//                                                          privileges on reporting views, direct EXECUTE on trigger functions) from `authenticated`
//   20261118000005_profile_guard_hosted_compatible       -- function body only: public.enforce_profile_self_update() no longer reads retired columns directly
// Same shape as the P0 runner: dry run first (transaction + ROLLBACK + proof nothing changed), --live only with the exact phrase, one transaction,
// every gate behavioural, refusal once history reaches 98. Prints names and counts only.
//
//   node --env-file=.env.local scripts/staging/apply-hardening-migrations.mjs --expected-head=<sha> --backup=<fresh.enc.json>                      (dry run)
//   node --env-file=.env.local scripts/staging/apply-hardening-migrations.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE>"
//   node --env-file=.env.local scripts/staging/apply-hardening-migrations.mjs --verify-applied                                                  (read-only)
//   node --env-file=.env.local scripts/staging/apply-hardening-migrations.mjs --observe                                                         (read-only pre-state)
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
  { version: "20261118000004", name: "revoke_excess_authenticated_grants", sha256: "4559b5e71bab46706a6826502a29a8b9fb273c2d1275e413702ed951cde7ee53" },
  { version: "20261118000005", name: "profile_guard_hosted_compatible", sha256: "78fa23afa2324c40f8fac430a29084e9b24fc9dd4c2d47d8efeb855c9562b552" },
];
export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
/** The pushed baseline carrying the verified P0 rollout; HEAD must descend from it. */
export const PUSHED_BASE = "5eff6de83a1f0b3cb778c3ee4046b09086c643ef";
export const PRE_COUNT = 96;
export const LAST_PRE = "20261118000003";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} THROUGH ${POST_LAST} TO STAGING ${APPROVED_REF}`;

/** Frozen from a read-only observation of the approved staging project (run `--observe`); any difference aborts before anything is written. */
export const PRE_STATE = {
  tablePrivsMd5: "d69157956e5cc0c8ec3f7808c57fea5b",
  fnExecMd5: "d41b59609b2a15aa8e15f54c227ad932",
  guardBodyMd5: "42d1d9c7903873c710d9a7ec2286020d", // md5 of the LF-normalised pg_get_functiondef of public.enforce_profile_self_update() on hosted
};

export const WRITER = "aso";
export const OTHER_STATION = "aso-jhb";
export const PENDING = "neg-pending-profile";
export const EXPECTED_PROBES = 15;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const md5 = (t) => crypto.createHash("md5").update(String(t ?? "")).digest("hex");
const fail = (m) => { throw new Error(m); };

/** The explicit sets the ACL migration revokes (frozen; the migration text is checked against them by statementAudit). */
export const REVOKE_TABLE_NAMES = ["absence_notices", "aircraft_types", "announcement_acknowledgements", "announcements", "bay_board", "duty_audit_log", "duty_records", "duty_zones", "enforcement_search_log", "offload_items", "offload_records", "overtime_requests", "phase13_readiness_access_log", "profiles", "report_acknowledgements", "report_attachments", "report_counters", "report_drafts", "report_sec013", "report_sec013_profiling_duties", "report_sec014", "report_sec014_patrols", "report_sec016", "report_sec018", "report_sec018_patrols", "report_sec029", "report_sec029_items", "report_sec033", "report_sec033_hold_checks", "role_definitions", "sheet_sync_config", "sheet_sync_queue", "shift_handovers", "shifts", "station_teams", "stations", "team_rosters", "teams", "user_notifications", "user_registration_requests", "v_phase2_backfill_coverage", "v_phase2_unclassified_stations", "v_report_index_classification_gaps", "v_report_index_current_version_mismatch", "v_report_index_queue_health", "wois_audit_log", "wois_conversations", "wois_messages"];
export const REVOKE_VIEW_NAMES = ["v_phase2_backfill_coverage", "v_phase2_unclassified_stations", "v_report_index_classification_gaps", "v_report_index_current_version_mismatch", "v_report_index_queue_health"];
export const REVOKE_FUNCTION_NAMES = ["block_duty_remark_rewrite", "block_settled_overtime_mutation", "block_submitted_child_mutation_offload", "block_submitted_child_mutation_sec013", "block_submitted_child_mutation_sec014", "block_submitted_child_mutation_sec018", "block_submitted_child_mutation_sec029", "block_submitted_child_mutation_sec033", "block_submitted_report_mutation", "enforce_announcement_delete_guard", "enforce_announcement_immutability", "enforce_overtime_transition", "enforce_profile_self_update", "enforce_registration_request_self_write", "enforce_seal_color", "enqueue_sheet_sync", "guard_incident_update", "guard_part_update", "log_audit_admin", "notify_supervisors_on_incident", "set_report_no_offload", "set_report_no_sec013", "set_report_no_sec014", "set_report_no_sec016", "set_report_no_sec018", "set_report_no_sec029", "set_report_no_sec033", "set_updated_at", "set_updated_at_user_registration_requests", "set_vendor_transaction_number"];
const DANGEROUS = ["TRUNCATE", "TRIGGER", "REFERENCES"];
const VIEW_WRITES = ["INSERT", "UPDATE", "DELETE"];

const alt = (names) => names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const ALLOWED_STATEMENTS = [
  /^set local lock_timeout = '5s'$/,
  new RegExp(`^revoke truncate, trigger, references on table public\\.(${alt(REVOKE_TABLE_NAMES)}) from authenticated$`),
  new RegExp(`^revoke insert, update, delete on table public\\.(${alt(REVOKE_VIEW_NAMES)}) from authenticated$`),
  /^revoke delete on table public\.shift_handovers from authenticated$/,
  new RegExp(`^revoke execute on function public\\.(${alt(REVOKE_FUNCTION_NAMES)})\\(\\) from authenticated$`),
  // the function body: exactly one create or replace of the profile guard, with its security properties
  /^create or replace function public\.enforce_profile_self_update\(\) returns trigger language plpgsql security definer set search_path to 'public' as ''$/,
];
/** What the dollar-quoted guard body may never contain. */
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
  return bad ? bad.slice(0, 120) : null;
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
  if (after.join() !== MIGRATIONS.map((m) => m.version).join()) fail(`the repository holds migrations after ${LAST_PRE} other than the two frozen ones (${after.join()})`);
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
const defaultLog = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `hardening-${process.pid}.log`), l + "\n"); };

const ROLES = "array['anon','authenticated','service_role']";
const TABLE_PRIV_SQL = `select c.relname||':'||r.rolname||':'||p as k from pg_class c cross join unnest(${ROLES}) r(rolname) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.rolname, c.oid, p) order by 1`;
const FN_EXEC_SQL = `select p.oid::regprocedure::text||':'||r.rolname as k from pg_proc p cross join unnest(${ROLES}) r(rolname) where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and has_function_privilege(r.rolname, p.oid, 'EXECUTE') order by 1`;
const GUARD_SQL = "select pg_get_functiondef('public.enforce_profile_self_update()'::regprocedure) d, p.prosecdef sd, coalesce(p.proconfig::text,'') cfg, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl from pg_proc p where p.oid = 'public.enforce_profile_self_update()'::regprocedure";

/** The three observations the frozen PRE_STATE is made of (also what --observe prints). */
export async function observe(q) {
  const tablePrivs = (await q(TABLE_PRIV_SQL)).map((r) => r.k);
  const fnExec = (await q(FN_EXEC_SQL)).map((r) => r.k);
  const g = (await q(GUARD_SQL))[0];
  return { tablePrivs, fnExec, tablePrivsMd5: md5(tablePrivs.join(",")), fnExecMd5: md5(fnExec.join(",")), guardBodyMd5: md5(canonicalSql(g.d)), guard: { secdef: g.sd, cfg: g.cfg, owner: g.owner, acl: g.acl } };
}

/** The privileges this migration set must remove, derived from the frozen sets: exactly these, and only where they are currently held. */
export function expectedRemovals(obs) {
  const removed = new Set();
  const held = new Set(obs.tablePrivs);
  for (const t of REVOKE_TABLE_NAMES) for (const p of DANGEROUS) if (held.has(`${t}:authenticated:${p}`)) removed.add(`${t}:authenticated:${p}`);
  for (const t of REVOKE_VIEW_NAMES) for (const p of VIEW_WRITES) if (held.has(`${t}:authenticated:${p}`)) removed.add(`${t}:authenticated:${p}`);
  if (held.has("shift_handovers:authenticated:DELETE")) removed.add("shift_handovers:authenticated:DELETE");
  const fnHeld = new Set(obs.fnExec);
  const fnRemoved = new Set();
  for (const f of REVOKE_FUNCTION_NAMES) if (fnHeld.has(`${f}():authenticated`)) fnRemoved.add(`${f}():authenticated`);
  return { removed, fnRemoved };
}

/** Everything the migrations must NOT change, as md5s (the profile guard function is the only function whose body may change). */
async function unrelatedFingerprint(q) {
  return {
    otherFunctions: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and p.proname <> 'enforce_profile_self_update' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
    functionProps: (await q("select md5(string_agg(p.oid::regprocedure::text||p.prosecdef::text||p.provolatile::text||coalesce(p.proconfig::text,'')||pg_get_userbyid(p.proowner), ',' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace"))[0].h,
    policies: (await q("select md5(string_agg(schemaname||tablename||policyname||cmd||permissive||array_to_string(roles,',')||coalesce(qual,'')||coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    columns: (await q("select md5(string_agg(table_name||column_name||data_type||is_nullable||coalesce(column_default,''), ',' order by table_name, ordinal_position)) h from information_schema.columns where table_schema = 'public'"))[0].h,
    constraints: (await q("select md5(string_agg(c.relname||k.conname||pg_get_constraintdef(k.oid), ',' order by c.relname, k.conname)) h from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace and k.contype <> 'n'"))[0].h,
    triggers: (await q("select coalesce(md5(string_agg(c.relname||t.tgname||pg_get_triggerdef(t.oid)||t.tgenabled::text, ',' order by c.relname, t.tgname)),'none') h from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"))[0].h,
    rls: (await q("select md5(string_agg(relname||relrowsecurity::text||relforcerowsecurity::text, ',' order by relname)) h from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')"))[0].h,
    columnGrants: (await q("select coalesce(md5(string_agg(c.relname||'.'||a.attname||':'||a.attacl::text, ',' order by c.relname, a.attname)),'none') h from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and a.attacl is not null and a.attnum>0 and not a.attisdropped"))[0].h,
    buckets: (await q("select coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)),'none') h from storage.buckets b"))[0].h,
    profiles: (await q("select coalesce(md5(string_agg(md5(p::text), ',' order by p.id::text)), 'none') h from public.profiles p"))[0].h,
    assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
    authUsers: (await q("select count(*)::text h from auth.users"))[0].h,
    publicGrantee: (await q("select count(*)::text h from information_schema.role_table_grants where table_schema='public' and grantee='PUBLIC'"))[0].h,
  };
}
const historyFingerprint = async (q) => (await q("select coalesce(md5(string_agg(version || name, ',' order by version)), 'none') h from supabase_migrations.schema_migrations"))[0].h;

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("a hardening migration is already recorded");
  if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
  const obs = await observe(q);
  const { removed, fnRemoved } = expectedRemovals(obs);
  if (removed.size === 0 && fnRemoved.size === 0) fail("none of the privileges this migration set removes is held: it has been applied already or the schema is not the reviewed one");
  if (ctx.hashes) {
    if (obs.tablePrivsMd5 !== ctx.hashes.tablePrivsMd5) fail("table privileges differ from the observed pre-state");
    if (obs.fnExecMd5 !== ctx.hashes.fnExecMd5) fail("function EXECUTE privileges differ from the observed pre-state");
    if (obs.guardBodyMd5 !== ctx.hashes.guardBodyMd5) fail("the profile guard function differs from the observed pre-state");
  }
  return obs;
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== (ctx.postCount ?? POST_COUNT) || mig[mig.length - 1]?.version !== (ctx.postLast ?? POST_LAST)) fail(`history is not ${ctx.postCount ?? POST_COUNT} ending ${ctx.postLast ?? POST_LAST} (${mig.length} / ${mig[mig.length - 1]?.version})`);
  for (const m of MIGRATIONS) if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) fail(`${m.version} is not recorded exactly once with its name`);
  const obs = await observe(q);
  const held = new Set(obs.tablePrivs);
  const stillHeld = [];
  for (const t of REVOKE_TABLE_NAMES) for (const p of DANGEROUS) if (held.has(`${t}:authenticated:${p}`)) stillHeld.push(`${t}:${p}`);
  for (const t of REVOKE_VIEW_NAMES) for (const p of VIEW_WRITES) if (held.has(`${t}:authenticated:${p}`)) stillHeld.push(`${t}:${p}`);
  if (held.has("shift_handovers:authenticated:DELETE")) stillHeld.push("shift_handovers:DELETE");
  if (stillHeld.length) fail(`authenticated still holds ${stillHeld.length} revoked privilege(s): ${stillHeld.slice(0, 3).join(",")}`);
  const fnHeld = new Set(obs.fnExec);
  const fnStill = REVOKE_FUNCTION_NAMES.filter((f) => fnHeld.has(`${f}():authenticated`));
  if (fnStill.length) fail(`authenticated can still execute ${fnStill.length} trigger function(s): ${fnStill.slice(0, 3).join(",")}`);
  if (!obs.guard.secdef || !/search_path=public/.test(obs.guard.cfg)) fail("the profile guard is not SECURITY DEFINER with a fixed search_path");
  const body = (await q(GUARD_SQL))[0].d;
  if (/new\.unified_role|new\.ops_group|new\.org_id|new\.duty_post/.test(body)) fail("the profile guard still reads a retired column directly");
  if (!/to_jsonb\(new\)/.test(body)) fail("the profile guard is not the repaired body");
  return { history: mig.length, last: mig[mig.length - 1].version, obs };
}

/**
 * ctx: { files, acct(label), live, log, preCount, lastPre, hashes|null, onSnapshot?, expectedProbes? }
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
  log("hosted pre-state verified exactly (history, table privileges, function EXECUTE privileges, profile guard body); the migrations' revoke sets are held");
  const pre = await unrelatedFingerprint(q);
  const preHistory = await historyFingerprint(q);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    guardDefinition: (await q(GUARD_SQL))[0].d,
    revokedTablePrivileges: [...expectedRemovals(preObs).removed],
    revokedFunctionExecute: [...expectedRemovals(preObs).fnRemoved],
    fingerprints: { unrelated: pre, history: preHistory, tablePrivsMd5: preObs.tablePrivsMd5, fnExecMd5: preObs.fnExecMd5, guardBodyMd5: preObs.guardBodyMd5 },
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
  const switchTo = (uid, role = "authenticated") => client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
  const tryStmt = async (sql, params) => { await client.query("SAVEPOINT t"); try { const r = await client.query(sql, params); return `ok:${r.rowCount ?? 0}`; } catch (e) { return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 90)}`; } finally { await client.query("ROLLBACK TO SAVEPOINT t"); } };

  async function pass(real) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      // ---- the defect, reproduced on the pre-state: a real user cannot update their own profile (hosted guard reads retired columns)
      const preSelf = await asUser(WRITER, () => tryStmt("update public.profiles set name = name where id = $1", [acct(WRITER)]));
      if (ctx.hashes && !/ERR:42703/.test(preSelf)) fail(`the profile-guard defect was not reproduced on the pre-state (${preSelf})`);
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
      }
      const hist = (await q("select count(*)::int n, max(version) v from supabase_migrations.schema_migrations"))[0];
      if (hist.n !== ctx.preCount + files.length || hist.v !== files[files.length - 1].version) fail(`migration history is not ${ctx.preCount + files.length} ending ${files[files.length - 1].version} (${hist.n} / ${hist.v})`);
      probe(`migration history is ${hist.n} ending ${hist.v}, each hardening version recorded once; ${ctx.hashes ? "the defect was reproduced first (" + preSelf.slice(0, 20) + ")" : "pre-repair self-update result: " + preSelf.slice(0, 30)}`);

      // ---- ACL: removed exactly the designed privileges, nothing else changed for any of the three roles
      const post = await observe(q);
      const { removed, fnRemoved } = expectedRemovals(preObs);
      const wantTables = new Set(preObs.tablePrivs.filter((k) => !removed.has(k)));
      const gotTables = new Set(post.tablePrivs);
      const lost = [...wantTables].filter((k) => !gotTables.has(k)), extra = [...gotTables].filter((k) => !wantTables.has(k));
      if (lost.length || extra.length) fail(`table privileges changed other than designed (unexpectedly lost ${lost.slice(0, 3)}; unexpectedly held ${extra.slice(0, 3)})`);
      probe(`table privileges: exactly ${removed.size} privilege(s) removed from authenticated (TRUNCATE/TRIGGER/REFERENCES, view writes, shift_handovers DELETE); every other privilege of anon, authenticated and service_role is identical`);
      const wantFns = new Set(preObs.fnExec.filter((k) => !fnRemoved.has(k)));
      const gotFns = new Set(post.fnExec);
      const lostF = [...wantFns].filter((k) => !gotFns.has(k)), extraF = [...gotFns].filter((k) => !wantFns.has(k));
      if (lostF.length || extraF.length) fail(`function EXECUTE privileges changed other than designed (lost ${lostF.slice(0, 3)}; gained ${extraF.slice(0, 3)})`);
      probe(`function EXECUTE: exactly ${fnRemoved.size} trigger function(s) lost authenticated EXECUTE; every callable function keeps its anon / authenticated / service_role access`);
      // service_role keeps everything it had
      if (post.tablePrivs.filter((k) => k.endsWith(":service_role:TRUNCATE")).length !== preObs.tablePrivs.filter((k) => k.endsWith(":service_role:TRUNCATE")).length) fail("service_role lost TRUNCATE somewhere");
      // ---- the guard function: only its body changed, security properties unchanged
      if (post.guard.secdef !== preObs.guard.secdef || post.guard.cfg !== preObs.guard.cfg || post.guard.owner !== preObs.guard.owner) fail("the profile guard's security properties changed"); // its ACL is covered by the exact EXECUTE-matrix comparison above (it is one of the trigger functions)
      if (post.guardBodyMd5 === preObs.guardBodyMd5) fail("the profile guard body did not change");
      const body = (await q(GUARD_SQL))[0].d;
      if (/new\.(unified_role|ops_group|org_id|duty_post)/.test(body) || !/to_jsonb\(new\)/.test(body)) fail("the profile guard is not the repaired body");
      probe("profile guard: only the function body changed (SECURITY DEFINER, search_path=public and owner identical); it no longer reads the retired columns directly");
      const mid = await unrelatedFingerprint(q);
      for (const k of Object.keys(pre)) if (mid[k] !== pre[k]) fail(`the migrations changed something they must not (${k})`);
      probe("every unrelated fingerprint is unchanged (other function bodies and properties, policies, columns, constraints, triggers, RLS, column grants, storage buckets, profiles data, assignments, Auth users, PUBLIC grants)");

      // ---- real-role behaviour
      const p = (await q("select id, station, team, name, staff_no from public.profiles where id = $1", [acct(WRITER)]))[0];
      if (!p?.station || !p?.team) fail(`${WRITER} has no station / team on its profile`);
      const ins = async (table, row) => { const cols = Object.keys(row); return (await client.query(`insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, cols.map((c) => row[c]))).rows[0].id; };
      const today = (await q("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d"))[0].d;
      const triggersFire = await asUser(WRITER, async () => {
        const id = await ins("report_sec033", { profile_id: p.id, station: p.station, team: p.team, staff_name: p.name ?? "p", staff_id: p.staff_no ?? "p", report_date: today, report_time: "10:00", ops_group: null });
        await client.query("reset role"); // read back as the owner: SELECT on report columns is not granted to clients
        const r = (await client.query("select report_no is not null n from public.report_sec033 where id = $1", [id])).rows[0];
        await switchTo(acct(WRITER));
        return String(r.n);
      });
      if (triggersFire !== "true") fail(`triggers did not fire after the EXECUTE revoke (${triggersFire})`);
      probe(`${WRITER}: trigger functions still fire after the EXECUTE revoke (the report number is assigned by the trigger on a SEC033 insert)`);
      const denied = await asUser(WRITER, async () => {
        const out = [];
        for (const sql of ["truncate table public.report_sec013", "select public.set_updated_at()", "select public.set_report_no_sec013()", "delete from public.shift_handovers"]) { const r = await tryStmt(sql); out.push(r.match(/^ERR:(\d+)/)?.[1] ?? r.slice(0, 60)); }
        out.push((await client.query("select has_table_privilege('authenticated','public.v_report_index_queue_health','insert') or has_table_privilege('authenticated','public.v_report_index_queue_health','delete') w")).rows[0].w ? "view-writable" : "view-readonly");
        return out.join("|");
      });
      if (denied !== "42501|42501|42501|42501|view-readonly") fail(`authenticated was not refused as designed (${denied})`);
      probe(`${WRITER}: refused (permission denied) on TRUNCATE of a report table, on calling a trigger function directly (x2), on DELETE from shift_handovers and on writing a reporting view`);
      const kept = await asUser(WRITER, async () => {
        const has = async (sql) => (await client.query(sql)).rows[0].v;
        return [await has("select has_table_privilege('authenticated','public.shift_handovers','select')||'' v"), await has("select has_table_privilege('authenticated','public.shift_handovers','insert')||'' v"), await has("select has_table_privilege('authenticated','public.shift_handovers','update')||'' v"), await has("select has_table_privilege('authenticated','public.v_report_index_queue_health','select')||'' v"), await has("select has_table_privilege('authenticated','public.profiles','update')||'' v")].join("|");
      });
      if (kept !== "true|true|true|true|true") fail(`a required privilege was lost (${kept})`);
      probe("authenticated keeps SELECT / INSERT / UPDATE on shift_handovers, SELECT on the reporting views and UPDATE on profiles");

      // ---- profile guard behaviour (real roles)
      const guard = async (label, sql, params) => asUser(label, () => tryStmt(sql, params));
      const self = await guard(WRITER, "update public.profiles set name = $2 where id = $1", [acct(WRITER), p.name ?? "Name"]);
      if (!/^ok:1$/.test(self)) fail(`a user cannot update their own display name after the repair (${self})`);
      probe(`${WRITER}: can update their own display name (the defect is repaired)`);
      const escalations = [];
      for (const [col, val] of [["status", "rejected"], ["email", "p0-guard@example.test"], ["approved_by", acct(WRITER)], ["rejection_reason", "x"], ["station", "ZZZ"], ["staff_no", "ZZ99"]]) {
        const sql = col === "approved_by" ? "update public.profiles set approved_by = $2 where id = $1" : `update public.profiles set ${col} = $2 where id = $1`;
        const r = await guard(WRITER, sql, [acct(WRITER), val]);
        escalations.push(/ERR:P0001:(Not authorized to modify this field|Your account has already been reviewed)/.test(r) ? "refused" : `UNEXPECTED(${col}:${r})`);
      }
      if (escalations.some((e) => e !== "refused")) fail(`self-escalation was not refused by the guard (${escalations.join(",")})`);
      probe(`${WRITER}: cannot change their own status, email, approval fields, station or staff number (refused by the guard, not by an error)`);
      const other = await guard(WRITER, "update public.profiles set name = 'hijack' where id = $1", [acct(OTHER_STATION)]);
      if (!/ERR:(P0001:Not authorized to modify this profile|)/.test(other) && !/^ok:0$/.test(other)) fail(`a user could modify another profile (${other})`);
      probe(`${WRITER}: cannot modify another user's profile`);

      // ---- the real registration RPCs (they update profiles through the guard as the authenticated entity Admin); fixtures are rolled back
      const pend = acct(PENDING);
      const org = (await q("select s.id st, s.hub_id hub, (select t.id from public.org_teams t where t.station_id = s.id order by t.name limit 1) team, oe.id ent, oe.aoc_id aoc, (select d.id from public.departments d where d.aoc_id = oe.aoc_id and d.code = 'operation') dept from public.org_stations s, public.operating_entities oe where s.code = $1 and oe.code = 'MAA'", [p.station]))[0];
      if (!org?.team || !org?.dept) fail("the registration fixture could not find a station team / department");
      const newRequest = async () => (await client.query("insert into public.user_registration_requests (profile_id, requested_aoc_id, requested_operating_entity_id, requested_role_code, status) values ($1, $2, $3, 'aso', 'pending') returning id", [pend, org.aoc, org.ent])).rows[0].id;
      const approveSql = "select public.approve_registration_request($1, 'aso', $2, $3, $4, null, $5, $6, $7, null) as r";
      const approveArgs = (rid) => [rid, org.aoc, org.ent, org.dept, org.hub, org.st, org.team];
      await client.query("SAVEPOINT reg");
      const rid = await newRequest();
      const approve = await asUser("maa_admin", async () => (await client.query(approveSql, approveArgs(rid))).rows[0].r);
      const wrongEntity = await asUser("aax_admin", async () => (await client.query(approveSql, approveArgs(rid))).rows[0].r);
      const staffTry = await asUser(WRITER, async () => (await client.query(approveSql, approveArgs(rid))).rows[0].r);
      await client.query("ROLLBACK TO SAVEPOINT reg");
      if (typeof approve !== "string" || approve.startsWith("ERR:")) fail(`the authorized entity Admin could not approve a pending registration (${approve})`);
      probe("maa_admin: approves a pending MAA registration through approve_registration_request (assignment created; the profile is updated through the repaired guard)");
      if (!String(wrongEntity).startsWith("ERR:") || !String(staffTry).startsWith("ERR:")) fail(`an unauthorized role could approve (${wrongEntity} / ${staffTry})`);
      probe("aax_admin (other entity) and a station officer cannot approve that MAA registration (refused by the RPC's entity-admin check)");
      await client.query("SAVEPOINT reg");
      const rid2 = await newRequest();
      const reject = await asUser("maa_admin", async () => { await client.query("select public.reject_registration_request($1, 'p0 probe')", [rid2]); return "ok"; });
      const wrongReject = await asUser("aax_admin", async () => { await client.query("select public.reject_registration_request($1, 'p0 probe')", [rid2]); return "ok"; });
      await client.query("ROLLBACK TO SAVEPOINT reg");
      if (reject !== "ok") fail(`the authorized entity Admin could not reject (${reject})`);
      probe("maa_admin: rejects a pending MAA registration through reject_registration_request (rejection_reason and status are written through the repaired guard)");
      if (wrongReject === "ok") fail("the other entity's Admin could reject");
      probe("aax_admin (other entity) cannot reject that MAA registration");

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
  if (obsAfter.tablePrivsMd5 !== preObs.tablePrivsMd5 || obsAfter.fnExecMd5 !== preObs.fnExecMd5 || obsAfter.guardBodyMd5 !== preObs.guardBodyMd5) fail("privileges or the guard body changed after the rolled-back dry run");
  if ((await historyFingerprint(q)) !== preHistory) fail("migration history changed after the rolled-back dry run");
  log("staging is unchanged after the dry-run rollback (history 96, privileges, function EXECUTE, guard body, every fingerprint)");
  let committed = false;
  if (ctx.live) {
    const dryProbes = probes.length;
    await pass(true);
    committed = true;
    if (ctx.expectedProbes !== undefined && ctx.expectedProbes > 0 && probes.length !== 2 * dryProbes) fail("incomplete probe execution in the live pass");
    const postFp = await unrelatedFingerprint(q);
    for (const k of Object.keys(pre)) if (postFp[k] !== pre[k]) fail(`after the live apply an unrelated fingerprint changed (${k})`);
    const v = await verifyApplied(q, { postCount: ctx.preCount + files.length, postLast: files[files.length - 1].version });
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
  if (args.includes("--observe") || args.includes("--verify-applied")) {
    const { client, explicitCa } = await connectVerified();
    log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
    try {
      await client.query("begin read only");
      const rq = async (s, p) => (await client.query(s, p)).rows;
      if (args.includes("--observe")) {
        const o = await observe(rq);
        const { removed, fnRemoved } = expectedRemovals(o);
        console.log(JSON.stringify({ tablePrivsMd5: o.tablePrivsMd5, fnExecMd5: o.fnExecMd5, guardBodyMd5: o.guardBodyMd5, wouldRemoveTablePrivileges: removed.size, wouldRemoveFunctionExecute: fnRemoved.size }, null, 1));
      } else {
        const v = await verifyApplied(rq);
        log(`VERIFIED: history ${v.history} ending ${v.last}; revoked privileges are gone; the profile guard is the repaired body`);
      }
      await client.query("rollback");
    } finally { await client.end().catch(() => {}); }
    return;
  }
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`hardening migrations: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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
        const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-hardening-prechange-${Date.now()}.enc.json`);
        fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload(snapshot, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
        decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
        log(`pre-change snapshot (guard definition, revoked privileges, fingerprints) written and re-authenticated (${path.basename(snap)})`);
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
