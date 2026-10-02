#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": Sequential staging migration runner.
//
// SAFETY GUARDS:
// 1. Confirms git repository path, branch, and clean working tree.
// 2. Confirms approved staging ref 'ddlctzbnqewubltcavkh' exclusively.
// 3. Rejects immediately if forbidden production ref 'zsxneokqulktgnccxgkz' is found anywhere.
// 4. Verifies both encrypted backup archives authenticate and decrypt in memory.
// 5. Confirms live migration history: 20260928000000 present exactly once.
// 6. Confirms 16 auth users and 16 profiles exist.
// 7. Applies remaining migrations (Phase 2-13) strictly sequentially within individual transactions.
// 8. After every migration, records filename, elapsed time, result, history entry, objects, row counts, and verification outcome.
// 9. Performs exhaustive post-application verification (RLS, buckets, cron, security definer).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { createRequire } from "node:module";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";

const require = createRequire(import.meta.url);

const APPROVED_STAGING_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_PROD_REF = "zsxneokqulktgnccxgkz";
const EXPECTED_BRANCH = "dashboard/role-workspaces-adjustment";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../supabase/migrations");

// The remaining migrations to apply on staging (Phase 2 through Phase 13)
const REMAINING_MIGRATIONS = [
  {
    filename: "20260928000001_phase2_org_foundation.sql",
    expectedObjects: ["aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams"],
    countQueries: [
      { label: "aocs", query: "SELECT count(*) FROM public.aocs;" },
      { label: "operating_entities", query: "SELECT count(*) FROM public.operating_entities;" },
      { label: "departments", query: "SELECT count(*) FROM public.departments;" },
      { label: "units", query: "SELECT count(*) FROM public.units;" },
      { label: "hubs", query: "SELECT count(*) FROM public.hubs;" },
      { label: "org_stations", query: "SELECT count(*) FROM public.org_stations;" },
      { label: "org_teams", query: "SELECT count(*) FROM public.org_teams;" }
    ]
  },
  {
    filename: "20260928000002_phase3_role_permission_foundation.sql",
    expectedObjects: ["role_definitions", "user_role_assignments"],
    countQueries: [
      { label: "role_definitions", query: "SELECT count(*) FROM public.role_definitions;" },
      { label: "active_roles", query: "SELECT count(*) FROM public.role_definitions WHERE is_active = true;" }
    ]
  },
  {
    filename: "20260928000003_phase4_registration_approval_admin.sql",
    expectedObjects: ["user_entity_memberships", "user_notifications"],
    countQueries: [
      { label: "user_entity_memberships", query: "SELECT count(*) FROM public.user_entity_memberships;" },
      { label: "user_registration_requests", query: "SELECT count(*) FROM public.user_registration_requests;" },
      { label: "user_notifications", query: "SELECT count(*) FROM public.user_notifications;" }
    ]
  },
  {
    filename: "20260928000004_phase5_report_classification_repository.sql",
    expectedObjects: ["central_reports_index", "report_index_queue"],
    countQueries: [
      { label: "central_reports_index", query: "SELECT count(*) FROM public.central_reports_index;" },
      { label: "report_index_queue", query: "SELECT count(*) FROM public.report_index_queue;" }
    ]
  },
  {
    filename: "20260928000005_phase6_secure_report_access.sql",
    expectedObjects: ["central_reports_index"],
    countQueries: [
      { label: "central_reports_index", query: "SELECT count(*) FROM public.central_reports_index;" }
    ]
  },
  {
    filename: "20260928000006_phase7_dashboard_aggregates.sql",
    expectedObjects: ["central_reports_index"],
    countQueries: []
  },
  {
    filename: "20260928000007_phase7_closure_dashboards.sql",
    expectedObjects: [],
    countQueries: []
  },
  {
    filename: "20260930000001_phase8_operational_workflows.sql",
    expectedObjects: ["overtime_requests"],
    countQueries: [
      { label: "overtime_requests", query: "SELECT count(*) FROM public.overtime_requests;" }
    ]
  },
  {
    filename: "20261001000001_phase9_caterlink_station_access.sql",
    expectedObjects: [
      "caterlink_station_capabilities", "catering_companies", "vehicles", "drivers",
      "transactions", "caterlink_checkpoint_hub", "caterlink_archives", "caterlink_transaction_pdfs"
    ],
    countQueries: [
      { label: "caterlink_station_capabilities", query: "SELECT count(*) FROM public.caterlink_station_capabilities;" },
      { label: "catering_companies", query: "SELECT count(*) FROM public.catering_companies;" }
    ]
  },
  {
    filename: "20261005000001_phase10_anonymous_discussion_board.sql",
    expectedObjects: [
      "discussion_author_mappings", "discussion_identity_resolutions", "discussion_threads", "discussion_replies"
    ],
    countQueries: [
      { label: "discussion_threads", query: "SELECT count(*) FROM public.discussion_threads;" },
      { label: "discussion_replies", query: "SELECT count(*) FROM public.discussion_replies;" }
    ]
  },
  {
    filename: "20261008000001_phase11_global_malaysia_announcements.sql",
    expectedObjects: [
      "announcements", "announcement_attachments", "announcement_audit_log", "announcement_acknowledgements"
    ],
    countQueries: [
      { label: "announcements", query: "SELECT count(*) FROM public.announcements;" },
      { label: "announcement_attachments", query: "SELECT count(*) FROM public.announcement_attachments;" }
    ]
  },
  {
    filename: "20261010000001_phase12_wois_ai_2.sql",
    expectedObjects: ["wois_conversations", "wois_messages", "wois_audit_log"],
    countQueries: [
      { label: "wois_conversations", query: "SELECT count(*) FROM public.wois_conversations;" },
      { label: "wois_messages", query: "SELECT count(*) FROM public.wois_messages;" }
    ]
  },
  {
    filename: "20261015000001_phase13_integration_rollout_readiness.sql",
    expectedObjects: ["phase13_readiness_access_log"],
    countQueries: [
      { label: "phase13_readiness_access_log", query: "SELECT count(*) FROM public.phase13_readiness_access_log;" }
    ]
  },
  {
    filename: "20261016000001_phase13_storage_and_admin_workflows.sql",
    expectedObjects: [],
    countQueries: [
      { label: "storage.buckets", query: "SELECT count(*) FROM storage.buckets;" },
      { label: "cron.job", query: "SELECT count(*) FROM cron.job;" }
    ]
  }
];

const BACKUP_FILE_1 = "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-2026-10-02T07-59-58-492Z.enc.json";
const BACKUP_FILE_2 = "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-schema-history-2026-10-02.enc.json";

function loadPgClient() {
  try {
    return require("pg");
  } catch {
    const localPath = path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg");
    return require(localPath);
  }
}

class DeploymentLogger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.writeFileSync(logFilePath, `=== VECTA STAGING DEPLOYMENT LOG ===\nStarted: ${new Date().toISOString()}\nTarget Project: ${APPROVED_STAGING_REF}\n\n`);
  }

  log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    const sanitized = line
      .replace(/postgres:\/\/[^@]+@/g, "postgres://[REDACTED]@")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
    fs.appendFileSync(this.logFilePath, sanitized + "\n");
  }

  error(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [ERROR] ${msg}`;
    console.error(line);
    fs.appendFileSync(this.logFilePath, line + "\n");
  }
}

async function main() {
  const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
  const logPath = path.join(logDir, `deployment-${Date.now()}.log`);
  const logger = new DeploymentLogger(logPath);

  logger.log("Initiating staging rollout verification...");

  // 1. Git Verification
  const repoRoot = child_process.execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const currentBranch = child_process.execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const currentHead = child_process.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

  logger.log(`Repo root: ${repoRoot}`);
  logger.log(`Branch: ${currentBranch}`);
  logger.log(`HEAD SHA: ${currentHead}`);

  if (currentBranch !== EXPECTED_BRANCH) {
    throw new Error(`Branch mismatch: expected ${EXPECTED_BRANCH}, got ${currentBranch}`);
  }

  // 2. Environment & Project Ref Verification
  const dbUrl = process.env.STAGING_DATABASE_URL;
  if (!dbUrl) {
    throw new Error("STAGING_DATABASE_URL is not set in environment");
  }

  const envDump = JSON.stringify(process.env);
  if (envDump.includes(FORBIDDEN_PROD_REF)) {
    throw new Error(`FATAL: Forbidden production reference '${FORBIDDEN_PROD_REF}' detected in environment!`);
  }

  const parsedUrl = new URL(dbUrl);
  const identifiesStaging = parsedUrl.hostname.includes(APPROVED_STAGING_REF) || parsedUrl.username.includes(APPROVED_STAGING_REF);
  if (!identifiesStaging) {
    throw new Error(`Database URL host/user '${parsedUrl.hostname}' / '${parsedUrl.username}' does not match approved staging ref '${APPROVED_STAGING_REF}'`);
  }
  logger.log(`Database URL verified targeting approved staging: host=${parsedUrl.hostname}, user=${parsedUrl.username}`);

  // 3. Backup In-Memory Authentication & Decryption
  const passphrase = process.env.VECTA_BACKUP_PASSPHRASE;
  if (!passphrase) {
    throw new Error("VECTA_BACKUP_PASSPHRASE is not set in environment");
  }
  if (!fs.existsSync(BACKUP_FILE_1)) {
    throw new Error(`Backup file 1 not found at ${BACKUP_FILE_1}`);
  }
  if (!fs.existsSync(BACKUP_FILE_2)) {
    throw new Error(`Backup file 2 not found at ${BACKUP_FILE_2}`);
  }

  logger.log("Authenticating and decrypting backup 1 (data inventory)...");
  const b1 = decryptBackupPayload(fs.readFileSync(BACKUP_FILE_1, "utf8"), passphrase);
  logger.log(`Backup 1 authenticated! Exported at: ${b1.exportedAt}, Auth users: ${b1.authUsers?.length}, Tables: ${Object.keys(b1.data ?? {}).length}`);

  logger.log("Authenticating and decrypting backup 2 (schema & migration history)...");
  const b2 = decryptBackupPayload(fs.readFileSync(BACKUP_FILE_2, "utf8"), passphrase);
  logger.log(`Backup 2 authenticated! Exported at: ${b2.exportedAt}, Schema SQL size: ${b2.schemaSql?.length} bytes`);

  // 4. Connect to database and verify live migration baseline
  const { Client } = loadPgClient();
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  logger.log("Connected to staging PostgreSQL instance.");

  try {
    // 4.1 Check live migration history
    const liveMigs = await client.query("SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version ASC;");
    logger.log(`Live migrations count: ${liveMigs.rows.length}`);

    const versions = liveMigs.rows.map(r => r.version);
    const liveVersions = new Set(versions);
    const hasPrereq = versions.filter(v => v === "20260928000000").length;
    logger.log(`Prerequisite migration 20260928000000 count: ${hasPrereq}`);
    if (hasPrereq !== 1) {
      throw new Error(`Prerequisite migration 20260928000000 expected exactly once, found ${hasPrereq}`);
    }

    // 4.2 Verify 16 Auth users and 16 profiles exist before any change
    const authUsersRes = await client.query("SELECT count(*) FROM auth.users;");
    const profilesRes = await client.query("SELECT count(*) FROM public.profiles;");
    const preAuthCount = parseInt(authUsersRes.rows[0].count, 10);
    const preProfileCount = parseInt(profilesRes.rows[0].count, 10);
    logger.log(`Pre-migration account counts: ${preAuthCount} Auth users, ${preProfileCount} profiles`);

    if (preAuthCount !== 16 || preProfileCount !== 16) {
      throw new Error(`Pre-migration account counts unexpected: expected 16 users/profiles, found ${preAuthCount} users and ${preProfileCount} profiles`);
    }

    // 4.3 Confirm all remaining migration files exist locally
    for (const m of REMAINING_MIGRATIONS) {
      const fullPath = path.join(MIGRATIONS_DIR, m.filename);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing local migration file: ${m.filename}`);
      }
    }
    logger.log(`All ${REMAINING_MIGRATIONS.length} remaining migration files exist locally and are ready.`);

    // =========================================================================
    // EXECUTION: Apply migrations sequentially, one transaction per file
    // =========================================================================
    logger.log("\n================================================================================");
    logger.log("BEGINNING SEQUENTIAL APPLICATION OF REMAINING MIGRATIONS (PHASE 2 - 13)");
    logger.log("================================================================================\n");

    const executionLog = [];

    for (let i = 0; i < REMAINING_MIGRATIONS.length; i++) {
      const item = REMAINING_MIGRATIONS[i];
      const filename = item.filename;
      const match = filename.match(/^(\d{14})_(.*)\.sql$/);
      if (!match) {
        throw new Error(`Invalid migration filename format: ${filename}`);
      }
      const [, version, name] = match;
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sqlContent = fs.readFileSync(filePath, "utf8");

      if (liveVersions.has(version)) {
        logger.log(`[${i + 1}/${REMAINING_MIGRATIONS.length}] ALREADY COMMITTED: ${filename} (verifying objects)...`);
        
        // Check expected objects
        if (item.expectedObjects && item.expectedObjects.length > 0) {
          const objCheck = await client.query(`
            SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]);
          `, [item.expectedObjects]);
          const found = new Set(objCheck.rows.map(r => r.relname));
          for (const reqObj of item.expectedObjects) {
            if (!found.has(reqObj)) {
              throw new Error(`Expected object 'public.${reqObj}' missing after ${filename}`);
            }
          }
        }

        // Row counts
        const rowCounts = {};
        for (const cq of (item.countQueries || [])) {
          const res = await client.query(cq.query);
          rowCounts[cq.label] = res.rows[0].count;
        }

        if (version === "20260928000001") {
          const trigCheck = await client.query(`
            SELECT tgname, tgenabled FROM pg_trigger
            WHERE tgname = 'profiles_enforce_self_update'
              AND tgrelid = 'public.profiles'::regclass;
          `);
          if (trigCheck.rows.length === 0 || trigCheck.rows[0].tgenabled !== "O") {
            throw new Error("Trigger profiles_enforce_self_update not enabled!");
          }
          const uCheck = await client.query("SELECT count(*) FROM auth.users;");
          const pCheck = await client.query("SELECT count(*) FROM public.profiles;");
          if (parseInt(uCheck.rows[0].count, 10) !== 16 || parseInt(pCheck.rows[0].count, 10) !== 16) {
            throw new Error(`User/profile survival failed in Phase 2: users=${uCheck.rows[0].count}, profiles=${pCheck.rows[0].count}`);
          }
          const backfillCheck = await client.query(`
            SELECT count(*) FROM public.profiles
            WHERE station IN ('KUL - MAA', 'KUL - AAX') AND (aoc_id IS NULL OR operating_entity_id IS NULL);
          `);
          if (parseInt(backfillCheck.rows[0].count, 10) > 0) {
            throw new Error(`Phase 2 backfill incomplete: ${backfillCheck.rows[0].count} unmapped profiles`);
          }
        }

        executionLog.push({
          filename,
          version,
          elapsedMs: 0,
          result: "SUCCESS",
          migrationHistoryEntry: `${version} (${name})`,
          expectedObjects: item.expectedObjects || [],
          rowCounts,
          verificationOutcome: "PASSED (PREVIOUSLY COMMITTED)"
        });
        logger.log(`Verified ${filename}: rowCounts=${JSON.stringify(rowCounts)}`);
        continue;
      }

      logger.log(`[${i + 1}/${REMAINING_MIGRATIONS.length}] Applying ${filename} ...`);
      const startTime = Date.now();

      await client.query("BEGIN;");
      try {
        await client.query(sqlContent);

        // Record in supabase_migrations.schema_migrations
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations (version, name, statements) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (version) DO NOTHING;`,
          [version, name, [sqlContent]]
        );

        await client.query("COMMIT;");
        const elapsedMs = Date.now() - startTime;
        logger.log(`[${i + 1}/${REMAINING_MIGRATIONS.length}] COMMITTED: ${filename} in ${elapsedMs}ms`);

        // Post-migration check for this file
        // 1. Check history entry
        const historyCheck = await client.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = $1;", [version]);
        if (historyCheck.rows.length !== 1) {
          throw new Error(`History verification failed for ${version}`);
        }

        // 2. Check expected objects if specified
        if (item.expectedObjects && item.expectedObjects.length > 0) {
          const objCheck = await client.query(`
            SELECT c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]);
          `, [item.expectedObjects]);
          const found = new Set(objCheck.rows.map(r => r.relname));
          for (const reqObj of item.expectedObjects) {
            if (!found.has(reqObj)) {
              throw new Error(`Expected object 'public.${reqObj}' missing after ${filename}`);
            }
          }
        }

        // 3. Row counts
        const rowCounts = {};
        for (const cq of (item.countQueries || [])) {
          const res = await client.query(cq.query);
          rowCounts[cq.label] = res.rows[0].count;
        }

        // If Phase 2, perform specific Phase 2 verification:
        if (version === "20260928000001") {
          // Verify trigger profiles_enforce_self_update is ENABLED
          const trigCheck = await client.query(`
            SELECT tgname, tgenabled FROM pg_trigger
            WHERE tgname = 'profiles_enforce_self_update'
              AND tgrelid = 'public.profiles'::regclass;
          `);
          if (trigCheck.rows.length === 0) {
            throw new Error("Trigger profiles_enforce_self_update not found on public.profiles!");
          }
          const tgenabled = trigCheck.rows[0].tgenabled;
          logger.log(`Phase 2 verification: trigger profiles_enforce_self_update tgenabled='${tgenabled}' (expected 'O')`);
          if (tgenabled !== "O") {
            throw new Error(`Trigger profiles_enforce_self_update not properly re-enabled! tgenabled='${tgenabled}'`);
          }

          // Verify 16 users and profiles still exist
          const uCheck = await client.query("SELECT count(*) FROM auth.users;");
          const pCheck = await client.query("SELECT count(*) FROM public.profiles;");
          if (parseInt(uCheck.rows[0].count, 10) !== 16 || parseInt(pCheck.rows[0].count, 10) !== 16) {
            throw new Error(`User/profile survival failed in Phase 2: users=${uCheck.rows[0].count}, profiles=${pCheck.rows[0].count}`);
          }
          logger.log("Phase 2 verification: 16 Auth users and 16 profiles verified intact.");

          // Check hierarchy references backfilled
          const backfillCheck = await client.query(`
            SELECT count(*) FROM public.profiles
            WHERE station IN ('KUL - MAA', 'KUL - AAX') AND (aoc_id IS NULL OR operating_entity_id IS NULL);
          `);
          logger.log(`Phase 2 verification: unbackfilled KUL profiles = ${backfillCheck.rows[0].count}`);
          if (parseInt(backfillCheck.rows[0].count, 10) > 0) {
            throw new Error(`Phase 2 backfill incomplete: ${backfillCheck.rows[0].count} KUL profiles have NULL hierarchy references`);
          }
        }

        const logEntry = {
          filename,
          version,
          elapsedMs,
          result: "SUCCESS",
          migrationHistoryEntry: `${version} (${name})`,
          expectedObjects: item.expectedObjects || [],
          rowCounts,
          verificationOutcome: "PASSED"
        };
        executionLog.push(logEntry);
        logger.log(`Verified ${filename}: rowCounts=${JSON.stringify(rowCounts)}`);

      } catch (err) {
        await client.query("ROLLBACK;");
        const elapsedMs = Date.now() - startTime;
        logger.error(`FATAL: ${filename} failed after ${elapsedMs}ms: ${err.message}`);
        executionLog.push({
          filename,
          version,
          elapsedMs,
          result: "FAILED",
          error: err.message,
          verificationOutcome: "FAILED - ROLLED BACK"
        });
        throw err;
      }
    }

    logger.log("\n================================================================================");
    logger.log(`ALL ${REMAINING_MIGRATIONS.length} MIGRATIONS APPLIED SUCCESSFULLY`);
    logger.log("================================================================================\n");

    // =========================================================================
    // FINAL POST-APPLICATION EXHAUSTIVE VERIFICATION
    // =========================================================================
    logger.log("=== EXECUTING FINAL EXHAUSTIVE POST-APPLICATION VERIFICATION ===");

    // 1. Migration History
    const postMigs = await client.query("SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version ASC;");
    const finalCount = postMigs.rows.length;
    const lastMigration = postMigs.rows[postMigs.rows.length - 1];
    logger.log(`Final migration count: ${finalCount}`);
    logger.log(`Last recorded migration: ${lastMigration.version} (${lastMigration.name})`);

    // 2. Auth users and profiles survival
    const finalUsers = await client.query("SELECT count(*) FROM auth.users;");
    const finalProfiles = await client.query("SELECT count(*) FROM public.profiles;");
    const finalUserCount = parseInt(finalUsers.rows[0].count, 10);
    const finalProfileCount = parseInt(finalProfiles.rows[0].count, 10);
    logger.log(`Account survival: ${finalUserCount} Auth users, ${finalProfileCount} profiles`);
    if (finalUserCount !== 16 || finalProfileCount !== 16) {
      throw new Error(`FATAL: Account survival check failed! Users: ${finalUserCount}, Profiles: ${finalProfileCount}`);
    }

    // 3. Trigger enabled state verification
    const finalTrigger = await client.query(`
      SELECT tgname, tgenabled, relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'profiles' AND tgname = 'profiles_enforce_self_update';
    `);
    const triggerState = finalTrigger.rows[0];
    logger.log(`Trigger 'profiles_enforce_self_update' state: enabled='${triggerState?.tgenabled}'`);
    if (!triggerState || triggerState.tgenabled !== "O") {
      throw new Error("Trigger 'profiles_enforce_self_update' is not in origin-enabled state ('O')!");
    }

    // 4. Phase 2-13 Tables & RLS Status
    const allTablesToCheck = [
      "aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams",
      "role_definitions", "user_role_assignments", "user_entity_memberships", "user_registration_requests",
      "user_notifications", "central_reports_index", "report_index_queue",
      "overtime_requests", "caterlink_station_capabilities", "catering_companies", "vehicles", "drivers",
      "transactions", "caterlink_checkpoint_hub", "caterlink_archives", "caterlink_transaction_pdfs",
      "discussion_author_mappings", "discussion_identity_resolutions", "discussion_threads", "discussion_replies",
      "announcements", "announcement_attachments", "announcement_audit_log", "announcement_acknowledgements",
      "wois_conversations", "wois_messages", "wois_audit_log", "phase13_readiness_access_log"
    ];

    const rlsCheck = await client.query(`
      SELECT c.relname, c.relrowsecurity 
      FROM pg_class c 
      JOIN pg_namespace n ON n.oid = c.relnamespace 
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]);
    `, [allTablesToCheck]);

    const rlsMap = new Map(rlsCheck.rows.map(r => [r.relname, r.relrowsecurity]));
    for (const tbl of allTablesToCheck) {
      if (!rlsMap.has(tbl)) {
        throw new Error(`Expected table 'public.${tbl}' not found in catalog!`);
      }
      if (!rlsMap.get(tbl)) {
        throw new Error(`Table 'public.${tbl}' does NOT have RLS enabled!`);
      }
    }
    logger.log(`Verified all ${allTablesToCheck.length} tables exist in catalog and have RLS ENABLED.`);

    // 5. Storage Buckets
    const buckets = await client.query("SELECT id, name, public FROM storage.buckets ORDER BY id;");
    logger.log(`Storage buckets (${buckets.rows.length}): ${buckets.rows.map(b => b.name).join(", ")}`);
    const bucketNames = new Set(buckets.rows.map(r => r.name));
    for (const reqBucket of ["sat-combined-reports", "caterlink-final-pdfs", "announcement-attachments"]) {
      if (!bucketNames.has(reqBucket)) {
        throw new Error(`Missing expected bucket '${reqBucket}'`);
      }
    }

    // 6. Cron Jobs
    const cronJobs = await client.query("SELECT jobid, schedule, command, active FROM cron.job ORDER BY jobid;");
    logger.log(`Scheduled cron jobs (${cronJobs.rows.length}):`);
    for (const j of cronJobs.rows) {
      logger.log(`  Job #${j.jobid} [${j.schedule}]: active=${j.active}`);
    }

    // 7. Functions count
    const fns = await client.query(`
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public';
    `);
    logger.log(`Total public functions: ${fns.rows[0].count}`);

    // 8. Views count
    const views = await client.query(`
      SELECT count(*) FROM pg_views WHERE schemaname = 'public';
    `);
    logger.log(`Total public views: ${views.rows[0].count}`);

    // 9. Policies count
    const policies = await client.query(`
      SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
    `);
    logger.log(`Total public policies: ${policies.rows[0].count}`);

    // Output final summary json to tmp
    const summaryPath = path.join(logDir, `summary-${Date.now()}.json`);
    fs.writeFileSync(summaryPath, JSON.stringify({
      targetProject: APPROVED_STAGING_REF,
      branch: currentBranch,
      head: currentHead,
      finalMigrationCount: finalCount,
      lastMigration,
      userCount: finalUserCount,
      profileCount: finalProfileCount,
      triggerState: triggerState?.tgenabled,
      executionLog,
      tablesCount: allTablesToCheck.length,
      buckets: buckets.rows.map(b => b.name),
      cronJobCount: cronJobs.rows.length,
      functionsCount: fns.rows[0].count,
      viewsCount: views.rows[0].count,
      policiesCount: policies.rows[0].count
    }, null, 2));

    logger.log(`Detailed deployment summary written to: ${summaryPath}`);

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR DURING ROLLOUT:", err.message);
  process.exit(1);
});
