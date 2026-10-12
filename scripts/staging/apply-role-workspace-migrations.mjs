#!/usr/bin/env node
// FROZEN-HASH STAGING MIGRATION RUNNER -- prepared, NOT executed.
//
// Applies exactly the eleven reviewed migrations below, in this order, to the approved staging project and
// to nothing else. It never runs unless every gate passes, it dry-runs everything first inside ONE transaction that is rolled back, and
// the live phase needs a separate explicit phrase plus a matching dry-run receipt. Prints names and counts only -- never a credential,
// connection string or secret.
//
//   node scripts/staging/apply-role-workspace-migrations.mjs --print-plan                  (no connection: order + hashes + files)
//   node scripts/staging/apply-role-workspace-migrations.mjs --print-recovery              (no connection: recovery per migration)
//   node --env-file=.env.local scripts/staging/apply-role-workspace-migrations.mjs --phase=dry-run --expected-head=<sha> --backup=<fresh.enc.json>
//   node --env-file=.env.local scripts/staging/apply-role-workspace-migrations.mjs --phase=apply   --expected-head=<sha> --backup=<fresh.enc.json> \
//        --dry-run-receipt=<path> --confirm="APPLY 11 MIGRATIONS TO STAGING ddlctzbnqewubltcavkh"
//
// Gates (all must pass, any failure stops immediately): exact repository path / branch / origin, clean tree, HEAD == --expected-head;
// approved staging ref only and the production ref absent everywhere; verified TLS (no insecure fallback); the existing encrypted
// backups authenticate AND a fresh backup (outside the repo, < 6 h old, same Auth-user count as the live database) authenticates;
// hosted history is exactly the expected starting point (ending 20261027000001, none of the new versions present); the repository holds
// exactly the frozen files above that point (no missing, extra, reordered or modified file: SHA-256 over LF-normalised text).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

export const START_LAST = "20261027000001";
export const START_COUNT = 68;
export const LIVE_PHRASE = `APPLY 11 MIGRATIONS TO STAGING ${APPROVED_REF}`;

/** version, name, frozen SHA-256 of the LF-normalised file, and what to do if it must be undone. */
export const MIGRATIONS = [
  { version: "20261027000002", name: "hub_destinations_kch_bki", sha256: "ffee7558b79356f8cfe1d66af3cbf99dd549ff43db6ab5c08f4b7a6c8674d1d5",
    recovery: "Additive CHECK widening (PEN/JHB/NILAI/KCH/BKI) on transactions.hub_destination and the hub checkpoint. Before any rollback confirm NO row uses KCH/BKI; then re-add the previous three-value constraints and delete the history row. If a KCH/BKI row exists, do not narrow: restore forward." },
  { version: "20261101000001", name: "flight_classification_and_report_access", sha256: "905906984e4d80de10739d5275ee0797150dce908782c77e3709ead5c1c6166b",
    recovery: "Additive. Leave in place; disable consumers by role revocation. A rollback is a restore from the fresh pre-change backup (schema_migrations row and new objects), never a partial drop." },
  { version: "20261101000002", name: "report_source_search_notifications", sha256: "3e403f81b1285e942c9cfae56c11e2f35a5e27b2d10e1c7a689fef07838b0984",
    recovery: "Additive. Leave in place; restore from the fresh pre-change backup if it must be removed." },
  { version: "20261101000003", name: "leadership_registration_directory_bayboard", sha256: "1807464e384e8c65ba83866be4d15d719fb6faf565c97bda03e6d226b30d6d44",
    recovery: "Additive. Leave in place; restore from the fresh pre-change backup if it must be removed." },
  { version: "20261101000004", name: "discussion_identity_reveal", sha256: "891cb8c6e37e005b360b65fe019e504972520c8c5c62db82224d126706524e14",
    recovery: "Additive. Leave in place; restore from the fresh pre-change backup if it must be removed." },
  { version: "20261101000005", name: "entity_report_counts_and_admin_overview", sha256: "8f4863685d1947463724810331b31e33cdf5ab9bd4535b5da6ef1ff75556da1b",
    recovery: "Additive. Leave in place; restore from the fresh pre-change backup if it must be removed." },
  { version: "20261102000001", name: "role_workspace_support", sha256: "b477f818c8e85fb88a0500ee8c5416fd897e42e5638bd74e91c0cb29ba3fc3ed",
    recovery: "Additive. Leave in place; restore from the fresh pre-change backup if it must be removed." },
  { version: "20261102000002", name: "entity_staff_maintenance", sha256: "d7a0a81c3866932c88a3aebd25aa645ccc429a59e625186f6ef3ac0a2f3b47ed",
    recovery: "Replaces the profile guard with a narrow entity-admin branch. Restore the previous function body from the pre-change definition snapshot, then delete the history row." },
  { version: "20261103000001", name: "role_workspace_completion", sha256: "8c6420b6eb4e80b401963cb8771325e095a138ec3e35d5f232350c150036f4d8",
    recovery: "Adds report_form_assignments (per-station ASO seeds), investigation case tables and workflow RPCs. Revoke assignments (revoked_at) rather than dropping; a full removal is a restore from the fresh backup." },
  { version: "20261104000001", name: "caterlink_receipt_pdf_version", sha256: "65943c95e3172b7af1caaebb9484c6dac93eaf763d5d641fb4a561e02cbe679f",
    recovery: "One service-role-only function. Drop record_caterlink_receipt_pdf_version(uuid,text,text,integer,uuid) only after dropping 20261105000001, which depends on it; versions already recorded are immutable data and stay." },
  { version: "20261105000001", name: "caterlink_pdf_generation_jobs", sha256: "292f070befd2e0fe1eb79b115403c7c20075f3a6fd74abd76accb4b357f6049b",
    recovery: "New table caterlink_pdf_jobs, one trigger on transactions and six functions. Disable by dropping trigger trg_enqueue_caterlink_receipt_pdf_job; the table holds only job status (no PDFs) and can then be dropped. Recorded PDF versions are never touched." },
];

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const flag = (k) => args.includes(`--${k}`);

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");
const fail = (m) => { throw new Error(m); };

export function normalisedSha256(buf) {
  return crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}

/** Local-only integrity check of the frozen set against the repository. Throws on a missing, extra, reordered or modified file. */
export function verifyFrozenFiles(root) {
  const dir = path.join(root, "supabase", "migrations");
  const versions = MIGRATIONS.map((m) => m.version);
  if (versions.some((v, i) => i > 0 && !(v > versions[i - 1])) || versions[0] <= START_LAST) fail("frozen order is not strictly ascending after the starting point");
  const onDisk = fs.readdirSync(dir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  const after = onDisk.filter((f) => f.slice(0, 14) > START_LAST);
  const expected = MIGRATIONS.map((m) => `${m.version}_${m.name}.sql`);
  if (JSON.stringify(after) !== JSON.stringify(expected)) fail(`repository migrations after ${START_LAST} differ from the frozen list (missing, extra or reordered): ${after.join(",")}`);
  return MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = fs.readFileSync(path.join(dir, file));
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    return { ...m, file, sql: buf.toString("utf8") };
  });
}

if ((flag("print-plan") || flag("print-recovery")) && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "../..");
  const files = verifyFrozenFiles(root);
  console.log(`Frozen set verified locally: ${files.length} migrations after ${START_LAST}`);
  files.forEach((f, i) => console.log(`${String(i + 1).padStart(2)}. ${f.version}_${f.name}  sha256=${f.sha256}${flag("print-recovery") ? `\n    RECOVERY: ${f.recovery}` : ""}`));
  process.exit(0);
}

const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(path.join(logDir, `role-workspace-migrations-${process.pid}.log`), l + "\n"); };

async function fingerprints(client) {
  const f = async (s) => (await client.query(s)).rows[0].v;
  return {
    auth: await f("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,''), ',' order by u.id::text)) v from auth.users u"),
    profiles: await f("select md5(string_agg(md5(p::text), ',' order by p.id::text)) v from public.profiles p"),
    transactions: await f("select coalesce(md5(string_agg(md5(t::text), ',' order by t.id::text)), 'none') v from public.transactions t"),
    storageObjects: await f("select count(*)::text v from storage.objects"),
    legacyHubStations: await f("select coalesce(md5(string_agg(md5(c::text), ',' order by c.id::text)), 'none') v from public.caterlink_station_capabilities c where c.station_code in ('PEN','JHB','NILAI')"),
  };
}

/** Post-migration checks for the whole set (read-only). Throws on the first mismatch. */
async function verifyAndProbe(client, manifest, pre) {
  const q = async (s, p) => (await client.query(s, p)).rows;
  const one = async (s, p) => (await q(s, p))[0];
  // history: each new version exactly once, nothing else added
  for (const m of MIGRATIONS) if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [m.version])).length !== 1) fail(`history does not hold ${m.version} exactly once`);
  if ((await one("select count(*)::int n from supabase_migrations.schema_migrations")).n !== START_COUNT + MIGRATIONS.length) fail("unexpected history count");

  // KCH / BKI are valid HUB destinations; BTU and KUL are not; PEN / JHB / NILAI capabilities are untouched
  const defs = (await q("select pg_get_constraintdef(oid) d from pg_constraint where conname in ('transactions_hub_destination_check','part_hub_confirmed_destination_check')")).map((r) => r.d).join(" ");
  for (const d of ["PEN", "JHB", "NILAI", "KCH", "BKI"]) if (!defs.includes(`'${d}'`)) fail(`hub destination constraint lacks ${d}`);
  if (/'BTU'|'KUL'/.test(defs)) fail("hub destination constraint admits BTU or KUL");
  const fp = await fingerprints(client);
  for (const k of ["auth", "profiles", "transactions", "storageObjects", "legacyHubStations"]) if (fp[k] !== pre[k]) fail(`unexpected change in ${k}`);
  const cap = async (st) => one("select can_scan, can_confirm_hub_receipt from public.caterlink_station_capabilities where station_code = $1", [st]);
  for (const st of ["KCH", "BKI"]) { const c = await cap(st); if (c && c.can_scan) fail(`${st} must not have a scanner`); }
  if (await cap("BTU")) { const c = await cap("BTU"); if (c.can_scan || c.can_confirm_hub_receipt) fail("BTU must have no CaterLink capability"); }

  // ASO form seed: one explicit row per active station and form, no all-station row; Profiling ASO SEC013 only; nothing else seeded
  if ((await one("select count(*)::int n from public.report_form_assignments where role_code = 'aso' and station_code is null and revoked_at is null")).n !== 0) fail("an all-station ASO row exists");
  const stations = (await one("select count(*)::int n from public.org_stations where is_active")).n;
  if ((await one("select count(*)::int n from public.report_form_assignments a join public.org_stations s on s.code = a.station_code and s.is_active where a.role_code = 'aso' and a.revoked_at is null")).n !== stations * 6) fail("ASO seed is not six rows per active station");
  const other = await q("select distinct role_code from public.report_form_assignments where revoked_at is null and role_code not in ('aso','profiling_aso')");
  if (other.length) fail("an unexpected role has report-form assignments");

  // privileges: nothing new is executable by anon; the worker and recorder are service-role only; the job table is closed
  const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
  if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
  for (const fn of ["claim_caterlink_pdf_jobs(integer,uuid)", "complete_caterlink_pdf_job(uuid,text,text,integer)", "fail_caterlink_pdf_job(uuid,text)", "record_caterlink_receipt_pdf_version(uuid,text,text,integer,uuid)"]) {
    const r = await one(`select has_function_privilege('authenticated', 'public.${fn}'::regprocedure, 'execute') a, has_function_privilege('service_role', 'public.${fn}'::regprocedure, 'execute') s`);
    if (r.a || !r.s) fail(`${fn} is not service-role only`);
  }
  const jt = await one("select c.relrowsecurity r, has_table_privilege('authenticated','public.caterlink_pdf_jobs','select') a, has_table_privilege('anon','public.caterlink_pdf_jobs','select') n from pg_class c where c.oid = 'public.caterlink_pdf_jobs'::regclass");
  if (!jt.r || jt.a || jt.n) fail("caterlink_pdf_jobs is not closed to API roles");
  if (!(await one("select count(*)::int n from pg_trigger where tgname = 'trg_enqueue_caterlink_receipt_pdf_job' and not tgisinternal")).n) fail("PDF job trigger missing");

  // real-role probes (rolled back): the review accounts, through the real RLS / RPC surface
  const idOf = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const as = async (uid) => { await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: uid, role: "authenticated" })]); };
  const probe = async (uid, sql, params) => { await client.query("SAVEPOINT p"); try { await as(uid); const r = await client.query(sql, params); await client.query("RESET ROLE"); await client.query("ROLLBACK TO SAVEPOINT p"); return { ok: true, rows: r.rows }; } catch (e) { await client.query("RESET ROLE").catch(() => {}); await client.query("ROLLBACK TO SAVEPOINT p"); return { ok: false, err: e.message }; } };
  const forms = async (label) => { const r = await probe(idOf(label), "select form_type from public.list_my_report_forms_secure()"); if (!r.ok) fail(`probe ${label}: ${redact(r.err)}`); return r.rows.map((x) => x.form_type).sort().join(","); };
  const standard = "offload,sec014,sec016,sec018,sec029,sec033";
  for (const label of ["aso-kul", "aso", "aso-jhb"]) if ((await forms(label)) !== standard) fail(`probe: ${label} does not get exactly the standard ASO forms`);
  if ((await forms("profiling_aso")) !== "sec013") fail("probe: Profiling ASO does not get SEC013 only");
  for (const label of ["caterlink_management", "operation_manager", "neg-pending-profile"]) if ((await forms(label)) !== "") fail(`probe: ${label} must have no report forms`);
  const scan = async (label, st) => (await probe(idOf(label), "select public.can_user_scan_caterlink($1) v", [st])).rows?.[0]?.v;
  if ((await scan("aso", "PEN")) !== true || (await scan("aso-jhb", "JHB")) !== true) fail("probe: PEN / JHB scanner behaviour changed");
  const jobs = await probe(idOf("caterlink_management"), "select * from public.list_caterlink_pdf_jobs_secure(true)");
  if (!jobs.ok) fail(`probe: CaterLink Management cannot list PDF jobs (${redact(jobs.err)})`);
  const retry = await probe(idOf("aso"), "select public.retry_caterlink_pdf_job_secure(gen_random_uuid())");
  if (retry.ok) fail("probe: an officer can retry a PDF job");
  const direct = await probe(idOf("aso"), "select * from public.claim_caterlink_pdf_jobs(1, null)");
  if (direct.ok) fail("probe: an officer can claim PDF jobs");
}

async function main() {
  const phase = argVal("phase");
  if (phase !== "dry-run" && phase !== "apply") fail("--phase=dry-run or --phase=apply is required");
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (phase === "apply") {
    if (argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase (see the header of this file)");
    if (!argVal("dry-run-receipt")) fail("--dry-run-receipt is required for the live phase");
  }
  fs.mkdirSync(logDir, { recursive: true });
  log(`role-workspace migrations: ${phase === "apply" ? "LIVE APPLY" : "DRY RUN (rolled back)"} starting`);

  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: path.resolve(import.meta.dirname, "../..") });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  log(`HEAD=${git.head.slice(0, 12)}; branch and origin verified; working tree clean`);
  const files = verifyFrozenFiles(git.root);
  log(`${files.length} migrations match their frozen SHA-256 and the repository holds no other migration after ${START_LAST}`);
  environmentGates();
  if (!process.env.STAGING_DATABASE_URL?.includes(APPROVED_REF) && !new URL(process.env.STAGING_DATABASE_URL).username.includes(APPROVED_REF)) fail("database URL is not the approved staging project");
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("production reference present");
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(freshBackup)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  const manifest = loadCurrentManifest();
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== START_COUNT || mig[mig.length - 1].version !== START_LAST) fail(`history is not exactly ${START_COUNT} ending ${START_LAST}`);
    if (mig.some((m) => MIGRATIONS.some((x) => x.version === m.version))) fail("a frozen migration is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
    const liveAuth = (await q("select count(*)::int n from auth.users"))[0].n;
    if (nb.authUsers?.length !== liveAuth) fail(`fresh backup lists ${nb.authUsers?.length} Auth users but the database has ${liveAuth}`);
    const pre = await fingerprints(client);
    const digest = crypto.createHash("sha256").update(MIGRATIONS.map((m) => m.sha256).join(",")).digest("hex");
    log(`pre-state verified; frozen-set digest ${digest.slice(0, 16)}...`);

    // ---------- DRY RUN: everything in one transaction, verified, then rolled back
    await client.query("BEGIN");
    try {
      for (const f of files) {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
        log(`dry run: ${f.version}_${f.name} applied (uncommitted)`);
      }
      await verifyAndProbe(client, manifest, pre);
      log("dry run: verification queries and real-role probes PASSED");
    } finally {
      await client.query("ROLLBACK");
    }
    const after = await q("select version from supabase_migrations.schema_migrations order by version");
    const post = await fingerprints(client);
    if (after.length !== START_COUNT || JSON.stringify(post) !== JSON.stringify(pre)) fail("the dry run left a change behind");
    if ((await q("select to_regclass('public.caterlink_pdf_jobs') r"))[0].r !== null) fail("the dry run left the job table behind");
    log("dry run rolled back; staging is exactly as before (history count, fingerprints, new objects re-checked)");

    if (phase === "dry-run") {
      const receipt = path.join(logDir, `role-workspace-dryrun-${git.head.slice(0, 12)}-${Date.now()}.json`);
      fs.writeFileSync(receipt, JSON.stringify({ head: git.head, digest, pre, at: new Date().toISOString() }), { mode: 0o600 });
      log(`dry-run receipt written: ${receipt}`);
      return;
    }

    // ---------- LIVE: the receipt must match this exact head, frozen set and untouched staging state
    const r = JSON.parse(fs.readFileSync(argVal("dry-run-receipt"), "utf8"));
    if (r.head !== git.head || r.digest !== digest || JSON.stringify(r.pre) !== JSON.stringify(pre)) fail("the dry-run receipt does not match this head, frozen set and staging state");
    if (Date.now() - new Date(r.at).getTime() > 24 * 3600 * 1000) fail("the dry-run receipt is older than 24 hours");
    for (const f of files) {
      if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [f.version])).length) fail(`${f.version} already recorded`);
      await client.query("BEGIN");
      try {
        await client.query(f.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
        if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [f.version])).length !== 1) fail("history entry is not exactly one");
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        log(`STOPPED at ${f.version}: ${redact(e.message)}`);
        log(`RECOVERY for ${f.version}: ${f.recovery}`);
        throw e;
      }
      log(`APPLIED ${f.version}_${f.name} (committed, recorded once)`);
    }
    await client.query("BEGIN");
    try { await verifyAndProbe(client, manifest, pre); log("post-apply verification and real-role probes PASSED"); } finally { await client.query("ROLLBACK"); }
    log("RESULT: SUCCESS");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
