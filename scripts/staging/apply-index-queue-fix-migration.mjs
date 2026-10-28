#!/usr/bin/env node
// Guarded runner for applying the index queue source table check & resume fix forward migration (20261130000003) to staging.
// Staging ONLY: ddlctzbnqewubltcavkh. Production (zsxneokqulktgnccxgkz) is strictly rejected.
//
// Usage:
//   node --env-file=.env.local scripts/staging/apply-index-queue-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-index-queue-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261130000003 TO STAGING ddlctzbnqewubltcavkh"
//   node --env-file=.env.local scripts/staging/apply-index-queue-fix-migration.mjs --verify-applied                                            (read-only)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261130000003", name: "allow_makeup_breakup_in_report_index_queue", sha256: "90676945ef1fced3552ba6713515947969e2d1f3b80210721b4ab9035f867e73" },
];

export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
export const PUSHED_BASE = "d42a6eeb3289067b7c06b6afc3d001f7949f4d77";
export const PRE_COUNT = 105;
export const LAST_PRE = "20261130000002";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^alter table public\.report_index_queue drop constraint if exists report_index_queue_source_table_check$/,
  /^alter table public\.report_index_queue add constraint report_index_queue_source_table_check check .*/,
  /^create or replace function public\.resume_report_submission_secure\(.*$/,
  /^revoke execute on function public\.resume_report_submission_secure\(text, uuid, jsonb\) from public, anon$/,
  /^grant execute on function public\.resume_report_submission_secure\(text, uuid, jsonb\) to authenticated, service_role$/,
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
    fail(`history is not ${expectedCount} ending ${expectedLast} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  for (const m of MIGRATIONS) {
    if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) {
      fail(`${m.version} is not recorded exactly once with its name`);
    }
  }
  return { history: mig.length, last: mig[mig.length - 1].version };
}

export async function execute(client, { files, acct, live = false, log = console.log, preCount = PRE_COUNT, lastPre = LAST_PRE, postCount = POST_COUNT, postLast = POST_LAST }) {
  const q = async (sql, p) => (await client.query(sql, p)).rows;
  await verifyPreState(q, { preCount, lastPre, files });

  const asoId = acct("aso-kul").profileId;

  async function asRole(profileId, role, fn) {
    await client.query("savepoint probe_user");
    try {
      const claims = {
        sub: profileId,
        role: role || (profileId ? "authenticated" : "anon"),
        email: profileId ? "user@airasia.test" : undefined,
      };
      await client.query("set local role to " + (claims.role === "service_role" ? "service_role" : "authenticated"));
      await client.query(`set local "request.jwt.claims" to '${JSON.stringify(claims)}'`);
      return await fn();
    } catch (e) {
      return `ERR: ${e.message}`;
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

      // Probe 1: report_index_queue permits inserting report_makeup
      const makeupQueueId = await asRole(null, "service_role", async () => {
        const dummyId = crypto.randomUUID();
        const res = await client.query(
          `insert into public.report_index_queue (source_table, source_id)
           values ('report_makeup', $1)
           returning id`,
          [dummyId]
        );
        return res.rows[0].id;
      });
      if (typeof makeupQueueId !== "string" || makeupQueueId.startsWith("ERR")) {
        fail(`Probe 1 failed to insert report_makeup into report_index_queue: ${makeupQueueId}`);
      }
      probe("report_index_queue accepts source_table = 'report_makeup'");

      // Probe 2: report_index_queue permits inserting report_breakup
      const breakupQueueId = await asRole(null, "service_role", async () => {
        const dummyId = crypto.randomUUID();
        const res = await client.query(
          `insert into public.report_index_queue (source_table, source_id)
           values ('report_breakup', $1)
           returning id`,
          [dummyId]
        );
        return res.rows[0].id;
      });
      if (typeof breakupQueueId !== "string" || breakupQueueId.startsWith("ERR")) {
        fail(`Probe 2 failed to insert report_breakup into report_index_queue: ${breakupQueueId}`);
      }
      probe("report_index_queue accepts source_table = 'report_breakup'");

      // Probe 3: report_index_queue still rejects invalid source_table
      const invalidQueue = await asRole(null, "service_role", async () => {
        const dummyId = crypto.randomUUID();
        await client.query(
          `insert into public.report_index_queue (source_table, source_id)
           values ('invalid_source_table', $1)`,
          [dummyId]
        );
        return "INSERTED";
      });
      if (invalidQueue === "INSERTED" || !String(invalidQueue).includes("violates check constraint")) {
        fail(`Probe 3 invalid source_table was unexpectedly allowed: ${invalidQueue}`);
      }
      probe("report_index_queue check constraint rejects invalid source_table");

      // Probe 4: resume_report_submission_secure accepts report_makeup without throwing Unsupported source_table
      const resumeTest = await asRole(asoId, "authenticated", async () => {
        const dummyId = crypto.randomUUID();
        await client.query(
          `select public.resume_report_submission_secure('report_makeup', $1, '[]'::jsonb)`,
          [dummyId]
        );
        return "OK";
      });
      // Should throw "Report not found.", NOT "Unsupported source_table: report_makeup"
      if (!String(resumeTest).includes("Report not found.")) {
        fail(`Probe 4 resume_report_submission_secure failed unexpectedly: ${resumeTest}`);
      }
      probe("resume_report_submission_secure recognizes report_makeup and report_breakup");

      // Probe 5: mark_report_ready_for_indexing succeeds for real report_makeup row
      const markReadyTest = await asRole(asoId, "authenticated", async () => {
        // Create a dummy report_makeup row owned by asoId
        const rRes = await client.query(
          `insert into public.report_makeup (profile_id, status, station, team, staff_name, staff_id, flight_number, duty_date, destination, first_baggage_time, last_baggage_tag_time, officer_confirmation)
           values ($1, 'submitted', 'KUL - MAA', 'ALPHA', 'UAT ASO', 'ASO-101', 'AK 111', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'PEN', '10:00', '10:30', true)
           returning id`,
          [asoId]
        );
        const repId = rRes.rows[0].id;

        // Insert 1 child baggage entry
        await client.query(
          `insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
           values ($1, 1, 'AKE12345AK', 'SL123', 'B1', 'PEN')`,
          [repId]
        );

        // Call mark_report_ready_for_indexing
        await client.query(
          `select public.mark_report_ready_for_indexing('report_makeup', $1, 1)`,
          [repId]
        );

        // Verify it was inserted into report_index_queue
        const qRes = await client.query(
          `select count(*) as cnt from public.report_index_queue where source_table = 'report_makeup' and source_id = $1`,
          [repId]
        );
        return qRes.rows[0].cnt === "1" ? "SUCCESS" : "MISSING_FROM_QUEUE";
      });
      if (markReadyTest !== "SUCCESS") {
        fail(`Probe 5 mark_report_ready_for_indexing test failed: ${markReadyTest}`);
      }
      probe("mark_report_ready_for_indexing successfully enqueues report_makeup without constraint violation");

      if (real) {
        log("recording migration in supabase_migrations.schema_migrations...");
        await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [files[0].version, files[0].name]);
        await client.query("COMMIT");
        log("LIVE TRANSACTION COMMITTED.");
      } else {
        await client.query("ROLLBACK");
        log("DRY RUN TRANSACTION ROLLED BACK.");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  log("\n--- STAGE 1: Transactional dry run with 5 behavioral probes ---");
  await pass(false);

  log("\n--- STAGE 2: Verifying pre-state preserved after rollback ---");
  await verifyPreState(q, { preCount, lastPre, files });
  log("Pre-state verified: exactly 105 migrations ending at 20261130000002.");

  if (!live) {
    log("\nDRY RUN COMPLETE: all 5 probes passed, pre-state cleanly preserved. Staging untouched.");
    return { dryRun: true, preStatePreserved: true };
  }

  log("\n--- STAGE 3: LIVE APPLICATION ---");
  await pass(true);

  log("\n--- STAGE 4: Verifying applied post-state ---");
  const post = await verifyApplied(q, { postCount, postLast });
  log(`LIVE APPLY SUCCESSFUL: ${post.history} migrations recorded, latest ${post.last}.`);
  return { live: true, post };
}

async function main() {
  const argv = process.argv.slice(2);
  productionGate();

  if (argv.includes("--verify-applied")) {
    const { client } = await connectVerified();
    try {
      const q = async (sql, p) => (await client.query(sql, p)).rows;
      const res = await verifyApplied(q);
      console.log(`Staging is at ${res.history} migrations ending at ${res.last}.`);
      return;
    } finally {
      await client.end();
    }
  }

  const expectedHead = argv.find((a) => a.startsWith("--expected-head="))?.split("=")[1];
  const backupPath = argv.find((a) => a.startsWith("--backup="))?.split("=")[1];
  const live = argv.includes("--live");
  const confirm = argv.find((a) => a.startsWith("--confirm="))?.split("=")[1];

  if (!expectedHead) fail("--expected-head=<sha> is required");
  if (!backupPath) fail("--backup=<fresh.enc.json> is required");
  if (live && confirm !== LIVE_PHRASE) fail(`--live requires exact --confirm="${LIVE_PHRASE}"`);

  const repoRoot = path.resolve(import.meta.dirname, "../..");
  runnerGitGates({ expectedHead, repoPath: repoRoot });

  if (!fs.existsSync(backupPath)) fail(`Backup not found: ${backupPath}`);
  const backupEnc = fs.readFileSync(backupPath, "utf8");
  const decrypted = decryptBackupPayload(backupEnc, process.env.VECTA_BACKUP_PASSPHRASE);
  console.log(`Verified backup decrypted: exportedAt=${decrypted.exportedAt}`);

  const migrationsDir = path.join(repoRoot, "supabase", "migrations");
  orderingGate(fs.readdirSync(migrationsDir));
  const files = verifyFrozenMigrations((f) => fs.readFileSync(path.join(migrationsDir, f)));

  const manifest = loadCurrentManifest();
  const acct = (label) => {
    const a = manifest.accounts[label];
    if (!a) fail(`Account label ${label} missing in manifest`);
    return a;
  };

  const { client } = await connectVerified();
  try {
    await execute(client, { files, acct, live });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}
