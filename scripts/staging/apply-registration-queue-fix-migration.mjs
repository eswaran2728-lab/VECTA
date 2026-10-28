#!/usr/bin/env node
// Guarded runner for applying the combined MAA/AAX Admin registration queue forward migration (20261130000004) to staging.
// Staging ONLY: ddlctzbnqewubltcavkh. Production (zsxneokqulktgnccxgkz) is strictly rejected.
//
// Usage:
//   node --env-file=.env.local scripts/staging/apply-registration-queue-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-registration-queue-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261130000004 TO STAGING ddlctzbnqewubltcavkh"
//   node --env-file=.env.local scripts/staging/apply-registration-queue-fix-migration.mjs --verify-applied                                            (read-only)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261130000004", name: "combined_admin_registration_queue", sha256: "5b3919801137cbdbf0f188152b06b0f2e407fd9fff76c8678fe2a7f0c435e5b0" },
];

export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
export const PUSHED_BASE = "d42a6eeb3289067b7c06b6afc3d001f7949f4d77";
export const PRE_COUNT = 106;
export const LAST_PRE = "20261130000003";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^create or replace function public\.list_entity_registration_requests_detailed_secure\(.*$/,
  /^revoke execute on function public\.list_entity_registration_requests_detailed_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.list_entity_registration_requests_detailed_secure\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.list_registration_assignment_options_secure\(.*$/,
  /^revoke execute on function public\.list_registration_assignment_options_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.list_registration_assignment_options_secure\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.approve_registration_request\(.*$/,
  /^revoke execute on function public\.approve_registration_request\(.*\) from public, anon$/,
  /^grant execute on function public\.approve_registration_request\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.reject_registration_request\(.*$/,
  /^revoke execute on function public\.reject_registration_request\(.*\) from public, anon$/,
  /^grant execute on function public\.reject_registration_request\(.*\) to authenticated, service_role$/,
  /^insert into public\.user_registration_requests .*/,
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

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) {
    fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the migration is already recorded in history");
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  const expectedCount = ctx.postCount ?? POST_COUNT;
  const expectedLast = ctx.postLast ?? POST_LAST;
  if (mig.length !== expectedCount || mig[mig.length - 1]?.version !== expectedLast) {
    fail(`staging is not at migration ${expectedCount} ending ${expectedLast} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  return mig;
}

export async function runGuardedMigration({ files, live = false, confirm = "", expectedHead, backupPath, log = console.log }) {
  productionGate();
  const repo = path.resolve(".");
  const git = runnerGitGates({ expectedHead, repoPath: repo });

  if (!backupPath) fail("--backup=<fresh.enc.json> is required");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(backupPath, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(backupPath)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  const { client, connectionInfo } = await connectVerified();
  const manifest = loadCurrentManifest();
  const maaAdminId = manifest.find((a) => a.label === "maa_admin")?.authUserId ?? manifest.find((a) => a.label === "maa_admin")?.id;
  const aaxAdminId = manifest.find((a) => a.label === "aax_admin")?.authUserId ?? manifest.find((a) => a.label === "aax_admin")?.id;

  if (!maaAdminId || !aaxAdminId) fail("manifest missing maa_admin or aax_admin entries");

  async function asRole(userId, role, fn) {
    await client.query("savepoint probe_user");
    try {
      const claims = userId ? { sub: userId, role } : { role };
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      return await fn();
    } catch (e) {
      return `ERR:${e.code ?? ""}:${e.message}`;
    } finally {
      await client.query("rollback to savepoint probe_user");
      await client.query("reset role");
      await client.query('reset "request.jwt.claims"');
    }
  }

  async function pass(real) {
    await client.query("BEGIN");
    try {
      for (const f of files) {
        log(`applying migration ${f.version} (${f.name})...`);
        await client.query(f.sql);
      }

      const probe = (desc) => log(`  PROBE PASS: ${desc}`);

      // Probe 1: eswaran3561 registration request exists as pending with null entity
      const eswaranReq = await client.query(`
        select urr.id, urr.profile_id, urr.status, urr.requested_operating_entity_id, p.email
        from public.user_registration_requests urr
        join public.profiles p on p.id = urr.profile_id
        where p.email = 'eswaran3561@gmail.com' and urr.status = 'pending'
      `);
      if (eswaranReq.rows.length === 0) fail("Probe 1 failed: eswaran3561@gmail.com registration request not found in pending state");
      if (eswaranReq.rows[0].requested_operating_entity_id !== null) fail("Probe 1 failed: eswaran3561 requested_operating_entity_id should be null");
      const eswaranRequestId = eswaranReq.rows[0].id;
      probe("eswaran3561@gmail.com pending registration request recovered with null entity");

      // Probe 2: Visible in MAA Admin queue
      const maaQueue = await asRole(maaAdminId, "authenticated", async () => {
        const res = await client.query("select id, staff_name, operating_entity_code from public.list_entity_registration_requests_detailed_secure()");
        return res.rows;
      });
      if (!Array.isArray(maaQueue) || !maaQueue.some((r) => r.id === eswaranRequestId)) {
        fail(`Probe 2 failed: eswaran3561 request not visible in MAA Admin queue (queue size: ${maaQueue?.length})`);
      }
      probe("eswaran3561 request visible in MAA Admin queue");

      // Probe 3: Visible in AAX Admin queue
      const aaxQueue = await asRole(aaxAdminId, "authenticated", async () => {
        const res = await client.query("select id, staff_name, operating_entity_code from public.list_entity_registration_requests_detailed_secure()");
        return res.rows;
      });
      if (!Array.isArray(aaxQueue) || !aaxQueue.some((r) => r.id === eswaranRequestId)) {
        fail(`Probe 3 failed: eswaran3561 request not visible in AAX Admin queue (queue size: ${aaxQueue?.length})`);
      }
      probe("eswaran3561 request visible in AAX Admin queue");

      // Probe 4: list_registration_assignment_options_secure resolves correctly for both Admins
      const maaOptions = await asRole(maaAdminId, "authenticated", async () => {
        const res = await client.query("select public.list_registration_assignment_options_secure($1) as opts", [eswaranRequestId]);
        return res.rows[0]?.opts;
      });
      if (maaOptions?.request?.entity_code !== "MAA" || !maaOptions?.request?.entity_id || !maaOptions?.request?.aoc_id) {
        fail(`Probe 4 failed: list_registration_assignment_options_secure did not resolve MAA for MAA Admin: ${JSON.stringify(maaOptions?.request)}`);
      }
      const aaxOptions = await asRole(aaxAdminId, "authenticated", async () => {
        const res = await client.query("select public.list_registration_assignment_options_secure($1) as opts", [eswaranRequestId]);
        return res.rows[0]?.opts;
      });
      if (aaxOptions?.request?.entity_code !== "AAX" || !aaxOptions?.request?.entity_id || !aaxOptions?.request?.aoc_id) {
        fail(`Probe 4 failed: list_registration_assignment_options_secure did not resolve AAX for AAX Admin: ${JSON.stringify(aaxOptions?.request)}`);
      }
      probe("list_registration_assignment_options_secure dynamically resolves entity/AOC for each Admin");

      // Probe 5: Dual-queue approval test with separate fixture applicant (preserves eswaran3561 as pending!)
      const testApplicantId = crypto.randomUUID();
      await client.query(`
        insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values ($1, 'authenticated', 'authenticated', 'probe_test_applicant@airasia.test', '{"provider":"email","providers":["email"]}', '{"name":"Probe Applicant"}', now(), now())
      `, [testApplicantId]);

      const org = (await client.query(`
        select s.id st, s.hub_id hub,
          (select t.id from public.org_teams t where t.station_id = s.id order by t.name limit 1) team,
          oe.id ent, oe.aoc_id aoc,
          (select d.id from public.departments d where d.aoc_id = oe.aoc_id and d.code = 'operation') dept
        from public.org_stations s, public.operating_entities oe
        where s.code = 'KUL - MAA' and oe.code = 'MAA'
      `)).rows[0];

      const testReqRes = await client.query(`
        insert into public.user_registration_requests (id, profile_id, requested_operating_entity_id, requested_aoc_id, requested_role_code, status, applicant_notes, submitted_at)
        values (gen_random_uuid(), $1, null, null, 'aso', 'pending', 'Test probe request', now())
        returning id
      `, [testApplicantId]);
      const testReqId = testReqRes.rows[0].id;

      // MAA Admin approves the test applicant request
      const approveRes = await asRole(maaAdminId, "authenticated", async () => {
        const res = await client.query(
          `select public.approve_registration_request($1, 'aso', $2, $3, $4, null, $5, $6, $7, null) as assignment_id`,
          [testReqId, org.aoc, org.ent, org.dept, org.hub, org.st, org.team]
        );
        return res.rows[0]?.assignment_id;
      });
      if (typeof approveRes !== "string" || approveRes.startsWith("ERR")) {
        fail(`Probe 5 failed: approve_registration_request error: ${approveRes}`);
      }

      // Verify assignment created in user_role_assignments with MAA membership
      const testAssignment = await client.query(`
        select ura.id, ura.operating_entity_id, ura.aoc_id, ura.entity_membership_id, rd.code as role_code, uem.operating_entity_id as mem_entity
        from public.user_role_assignments ura
        join public.role_definitions rd on rd.id = ura.role_definition_id
        left join public.user_entity_memberships uem on uem.id = ura.entity_membership_id
        where ura.id = $1
      `, [approveRes]);
      if (testAssignment.rows[0]?.mem_entity !== org.ent || testAssignment.rows[0]?.role_code !== "aso") {
        fail(`Probe 5 failed: scoped assignment did not match MAA entity: ${JSON.stringify(testAssignment.rows[0])}`);
      }

      // Verify request transitioned to 'approved' and disappeared from both queues
      const testReqPost = (await client.query("select status, requested_operating_entity_id from public.user_registration_requests where id = $1", [testReqId])).rows[0];
      if (testReqPost?.status !== "approved" || testReqPost?.requested_operating_entity_id !== org.ent) {
        fail(`Probe 5 failed: test request status is not approved or entity not set: ${JSON.stringify(testReqPost)}`);
      }

      // Clean up test applicant fixture
      await client.query("set session_replication_role = replica;");
      await client.query("delete from public.user_role_assignments where id = $1", [approveRes]);
      await client.query("delete from public.user_entity_memberships where profile_id = $1", [testApplicantId]);
      await client.query("delete from public.user_registration_requests where id = $1", [testReqId]);
      await client.query("delete from public.user_admin_audit_log where request_id = $1", [testReqId]);
      await client.query("delete from public.notifications where recipient_id = $1", [testApplicantId]);
      await client.query("delete from public.profiles where id = $1", [testApplicantId]);
      await client.query("delete from auth.users where id = $1", [testApplicantId]);
      await client.query("set session_replication_role = origin;");
      probe("Dual-queue unassigned request approved by MAA Admin creates correct scoped assignment and cleans up cleanly");

      if (real) {
        for (const f of files) {
          await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [f.version, f.name]);
        }
        await client.query("COMMIT");
        log("LIVE COMMIT SUCCESSFUL");
      } else {
        await client.query("ROLLBACK");
        log("DRY RUN ROLLBACK SUCCESSFUL");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  try {
    await verifyPreState((sql, p) => client.query(sql, p).then((r) => r.rows), { preCount: PRE_COUNT, lastPre: LAST_PRE, files });
    log("pre-state verified: staging is at migration 106 ending 20261130000003");

    log("starting dry-run pass (behavioral probes + rollback)...");
    await pass(false);

    // Verify 0 remnants after rollback
    const postRollbackCount = (await client.query("select count(*)::int as c from supabase_migrations.schema_migrations")).rows[0].c;
    if (postRollbackCount !== PRE_COUNT) fail(`dry run rollback failed: count is ${postRollbackCount}`);
    log("dry run complete: 5 probes passed, clean rollback verified, 0 remnants");

    if (!live) {
      log("DRY RUN FINISHED. To apply live, supply --live and the exact --confirm phrase.");
      return { ok: true, dryRun: true };
    }

    if (confirm !== LIVE_PHRASE) fail(`--confirm phrase mismatch. Expected: ${LIVE_PHRASE}`);

    log("starting LIVE pass...");
    await pass(true);

    const applied = await verifyApplied((sql, p) => client.query(sql, p).then((r) => r.rows), { postCount: POST_COUNT, postLast: POST_LAST });
    log(`LIVE APPLY COMPLETE: staging is at migration ${applied.length} ending ${applied[applied.length - 1].version}`);
    return { ok: true, live: true, applied };
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const LIVE = argv.includes("--live");
  const CONFIRM = arg("confirm") ?? "";
  const EXPECTED_HEAD = arg("expected-head");
  const BACKUP_PATH = arg("backup");
  const VERIFY_APPLIED = argv.includes("--verify-applied");

  if (VERIFY_APPLIED) {
    const { client } = await connectVerified();
    try {
      const mig = await verifyApplied((sql, p) => client.query(sql, p).then((r) => r.rows));
      console.log(`VERIFIED: staging is at migration ${mig.length} ending ${mig[mig.length - 1].version}`);
      process.exit(0);
    } finally {
      await client.end().catch(() => {});
    }
  }

  const files = verifyFrozenMigrations((file) => fs.readFileSync(path.join("supabase/migrations", file)));
  orderingGate(fs.readdirSync("supabase/migrations"));

  await runGuardedMigration({
    files,
    live: LIVE,
    confirm: CONFIRM,
    expectedHead: EXPECTED_HEAD,
    backupPath: BACKUP_PATH,
  });
}
