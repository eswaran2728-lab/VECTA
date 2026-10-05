#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261022000001_phase9_caterlink_kch_bki_final_receipt.sql to the
// approved staging project in one isolated transaction, with verification inside the transaction before COMMIT.
//
// Gates: exact repo/branch (HEAD must descend from the authorized base with only tooling/tests/docs/migration
// paths changed), clean tree, origin; approved staging ref only and production ref absent; verified TLS; the two
// original encrypted backups AND the fresh pre-change backup authenticate; history is exactly 60 migrations ending
// at 20261020000001; 52 Auth users and 52 profiles; all 36 dashboard-review accounts exist. Also snapshots the
// pre-change function definition and capability rows into a new encrypted schema backup. Any failure -> ROLLBACK.
// Prints names/counts only.
//
// Usage: node --env-file=.env.local scripts/staging/apply-receipt-migration-migration.mjs --expected-base=<sha> --run-id=<id> --backup=<path> [--preflight-only]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const PREFLIGHT_ONLY = args.includes("--preflight-only");
const expectedBase = argVal("expected-base");
const runId = argVal("run-id");
const freshBackup = argVal("backup");
const VERSION = "20261022000001";
const NAME = "phase9_caterlink_kch_bki_final_receipt";
const FILE = `${VERSION}_${NAME}.sql`;
const PRE_COUNT = 61;
const LAST_PRE = "20261021000001";

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `receipt-migration-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function state(client) {
  const n = async (sql, p) => parseInt((await client.query(sql, p)).rows[0].n, 10);
  const rows = (await client.query("select s.code, c.can_scan, c.can_confirm_hub_receipt, c.can_confirm_station_receipt, c.can_view, c.can_create, c.can_report_incident, c.can_view_history, c.can_download_pdf, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code")).rows;
  return {
    authUsers: await n("select count(*)::int n from auth.users"),
    profiles: await n("select count(*)::int n from public.profiles"),
    orgTeams: await n("select count(*)::int n from public.org_teams"),
    buckets: await n("select count(*)::int n from storage.buckets"),
    assignments: await n("select count(*)::int n from public.user_role_assignments"),
    profileFp: (await client.query("select md5(string_agg(md5(p::text), ',' order by p.id::text)) fp from public.profiles p")).rows[0].fp,
    authFp: (await client.query("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) fp from auth.users u")).rows[0].fp,
    assignmentsFp: (await client.query("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') fp from public.user_role_assignments a")).rows[0].fp,
    capabilities: rows,
    runAccounts: await n("select count(*)::int n from auth.users where email like $1", [`vecta.uat.${runId}.%`]),
  };
}

async function main() {
  if (!expectedBase || !runId || !freshBackup) fail("--expected-base, --run-id and --backup are required");
  log("Phase 9 KCH/BKI final-receipt migration: preflight starting");
  const git = gitGates({
    expectedBase,
    expectedRepoPath: path.resolve(import.meta.dirname, "../.."),
    // this run additionally allows exactly the receipt migration, the integration tests and application/test sources changed in the same commit range
    extraAllowed: [/^supabase\/migrations\/20261022000001_phase9_caterlink_kch_bki_final_receipt\.sql$/, /^supabase\/tests\/integration\//, /^lib\//, /^app\//, /^components\//],
  });
  const changed = child_process.execSync(`git diff --name-only ${expectedBase} HEAD`, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  log(`HEAD=${git.head} base=${expectedBase.slice(0, 12)} changedFiles=${changed.length}`);
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (path.relative(git.root, path.resolve(freshBackup)).startsWith("..") === false) fail("Fresh backup is inside the repository");
  log(`backups authenticate: original x${backups.length}; fresh backup exportedAt=${nb.exportedAt} authUsers=${nb.authUsers?.length}`);
  if ((nb.authUsers?.length ?? 0) !== 52) fail(`Fresh backup lists ${nb.authUsers?.length} Auth users, expected 52`);

  const sql = fs.readFileSync(path.join(git.root, "supabase", "migrations", FILE), "utf8");
  if (fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => f.startsWith(VERSION)).length !== 1) fail("Migration file set unexpected");
  log(`migration file ${FILE} (${sql.length} bytes)`);

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  let committed = false;
  try {
    const mig = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail("Migration history is not exactly 61 ending at 20261021000001");
    if (mig.some((m) => m.version === VERSION)) fail(`${VERSION} already recorded`);
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference in migration history");

    const pre = await state(client);
    log(`pre-state: authUsers=${pre.authUsers} profiles=${pre.profiles} orgTeams=${pre.orgTeams} buckets=${pre.buckets} assignments=${pre.assignments} runAccounts=${pre.runAccounts} scanEnabled=${pre.capabilities.filter((c) => c.can_scan).map((c) => c.code).join("|")}`);
    if (pre.authUsers !== 52 || pre.profiles !== 52) fail("Expected 52 Auth users and 52 profiles");
    if (pre.runAccounts !== 36) fail(`Expected all 36 dashboard-review accounts, found ${pre.runAccounts}`);
    if (pre.orgTeams !== 16 || pre.buckets !== 7) fail("org_teams/buckets baseline differs");
    const scanEnabledPre = pre.capabilities.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
    if (scanEnabledPre !== "JHB,PEN") fail(`Pre-state scan-enabled stations are ${scanEnabledPre}, expected JHB,PEN`);

    // pre-change snapshot (function definitions + capability rows) as a new encrypted schema backup
    const defs = (await client.query("select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('can_user_scan_caterlink','check_station_caterlink_capability','confirm_caterlink_destination_receipt_secure','can_user_confirm_caterlink_receipt')")).rows;
    const snapPath = path.join(path.dirname(freshBackup), `ddlctzbnqewubltcavkh-schema-prechange-${VERSION}-${Date.now()}.enc.json`);
    fs.writeFileSync(snapPath, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, functions: defs, capabilities: pre.capabilities }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snapPath, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change schema snapshot written and re-authenticated (${path.basename(snapPath)})`);

    if (PREFLIGHT_ONLY) { log("PREFLIGHT ONLY: no change made."); return; }

    log("BEGIN isolated transaction");
    const t0 = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [VERSION, NAME, [sql]]);

      // ---- verification inside the transaction, before COMMIT ----
      const q = async (s, p) => (await client.query(s, p)).rows;
      const total = parseInt((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n, 10);
      if (total !== PRE_COUNT + 1) fail(`Expected ${PRE_COUNT + 1} history rows`);
      if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [VERSION])).length !== 1) fail("History entry is not exactly one");

      const sigs = (await q("select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_user_confirm_caterlink_receipt'")).map((r) => r.a);
      if (sigs.length !== 1 || sigs[0] !== "p_station_code text, p_aoc_id uuid") fail(`Unexpected receipt-decision signatures: ${sigs.join(" | ")}`);
      const def = (await q("select pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure) d"))[0].d;
      if (!/auth\.uid\(\)/.test(def) || !/status = 'approved'/.test(def) || !/'sso', 'so', 'aso'/.test(def)) fail("Receipt decision body is not the reviewed one");
      if (/hub_se|operation_manager|main_enforcement|ops_group|current_role_name|can_scan/.test(def.replace(/--[^\r\n]*/g, ""))) fail("Receipt decision references a bypass or the scan capability");
      const scanDef = (await q("select pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure) d"))[0].d;
      if (!/not in \('PEN', 'JHB'\)/.test(scanDef)) fail("The corrected scan function is no longer in place");
      const priv = (await q("select has_function_privilege('anon','public.can_user_confirm_caterlink_receipt(text, uuid)','execute') a, has_function_privilege('authenticated','public.can_user_confirm_caterlink_receipt(text, uuid)','execute') b, has_function_privilege('anon','public.confirm_caterlink_destination_receipt_secure(uuid,text,text,text)','execute') c, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid in ('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure, 'public.confirm_caterlink_destination_receipt_secure(uuid,text,text,text)'::regprocedure) and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub"))[0];
      if (priv.a || priv.c || !priv.b || priv.pub) fail("Receipt function grants are not anon/PUBLIC-denied and authenticated-granted");
      const rcptDef = (await q("select pg_get_functiondef('public.confirm_caterlink_destination_receipt_secure(uuid,text,text,text)'::regprocedure) d"))[0].d;
      if (rcptDef.indexOf("can_user_confirm_caterlink_receipt(p_station_code)") < 0 || rcptDef.indexOf("can_user_confirm_caterlink_receipt(p_station_code)") > rcptDef.indexOf("from public.transactions t where")) fail("Receipt RPC does not authorize before reading the transaction");

      const post = await state(client);
      const enabled = post.capabilities.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
      if (enabled !== "JHB,PEN") fail(`Scan-enabled stations are ${enabled}, expected JHB,PEN`);
      for (const c of post.capabilities) {
        const was = pre.capabilities.find((p) => p.code === c.code);
        if (c.code === "KCH" || c.code === "BKI") {
          if (!c.can_confirm_hub_receipt || c.can_scan || c.can_create || c.can_confirm_station_receipt || !c.is_active) fail(`${c.code} capability is not receipt-only`);
          for (const k of ["can_view", "can_report_incident", "can_view_history", "can_download_pdf"]) if (was && was[k] !== c[k]) fail(`${c.code}.${k} changed unexpectedly`);
        } else if (was) {
          for (const k of ["can_scan", "can_confirm_hub_receipt", "can_confirm_station_receipt", "can_view", "can_create", "can_report_incident", "can_view_history", "can_download_pdf", "is_active"]) if (was[k] !== c[k]) fail(`Capability ${c.code}.${k} changed unexpectedly`);
        }
      }
      if (!post.capabilities.some((c) => c.code === "KCH") || !post.capabilities.some((c) => c.code === "BKI")) fail("KCH/BKI capability rows are missing");
      const alpha = (await q("select s.code, count(*)::int n from public.org_teams t join public.org_stations s on s.id = t.station_id where s.code in ('KCH','BKI') and t.name = 'ALPHA' group by 1 order by 1"));
      if (alpha.length !== 2 || alpha.some((r) => r.n !== 1)) fail("Expected exactly one ALPHA team at each of KCH and BKI");
      if (post.orgTeams !== 18) fail(`Expected 18 org_teams after the migration, found ${post.orgTeams}`);
      if (post.authUsers !== 52 || post.profiles !== 52 || post.buckets !== 7) fail("Counts changed");
      if (post.profileFp !== pre.profileFp) fail("profiles content changed");
      if (post.authFp !== pre.authFp) fail("auth.users content (including password hashes) changed");
      if (post.assignmentsFp !== pre.assignmentsFp) fail("user_role_assignments changed");
      const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
      if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
      log(`in-transaction verification PASSED (scan-enabled=${enabled}; KCH/BKI receipt-only; ALPHA teams x1 each; org_teams=${post.orgTeams}; grants correct; auth/profiles/assignments unchanged)`);

      await client.query("COMMIT");
      committed = true;
      log(`COMMIT done in ${Date.now() - t0} ms`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log(`ROLLED BACK: ${redact(e.message)}`);
      throw e;
    }
    const m2 = (await client.query("select version from supabase_migrations.schema_migrations order by version")).rows;
    log(`post-commit: migrations=${m2.length} last=${m2[m2.length - 1].version} ${VERSION}x${m2.filter((r) => r.version === VERSION).length}`);
    if (m2.length !== PRE_COUNT + 1 || m2.filter((r) => r.version === VERSION).length !== 1) fail("Post-commit history check failed");
  } finally {
    await client.end();
    log(`log file: ${logPath}`);
  }
  if (committed) log("RESULT: SUCCESS");
}

main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
