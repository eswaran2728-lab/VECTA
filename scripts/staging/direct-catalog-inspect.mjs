#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": Direct read-only database catalog & migration-history inspector.
//
// SAFETY GUARDS:
// 1. Accepts STAGING_DATABASE_URL only.
// 2. Refuses immediately if the URL targets forbidden production ('zsxneokqulktgnccxgkz').
// 3. Verifies URL targets approved staging ('ddlctzbnqewubltcavkh') or local clone.
// 4. Never prints or commits the connection string or credentials.
// 5. Executes read-only queries exclusively.
//
// Usage:
//   node --env-file=.env.local scripts/staging/direct-catalog-inspect.mjs
//   or
//   STAGING_DATABASE_URL="postgres://..." node scripts/staging/direct-catalog-inspect.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const APPROVED_STAGING_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_PROD_REF = "zsxneokqulktgnccxgkz";

async function loadPgClient() {
  try {
    return require("pg");
  } catch {
    try {
      const localPath = path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg");
      return require(localPath);
    } catch (e) {
      throw new Error("pg module not found. Run npm install or use the integration test pg module.");
    }
  }
}

function validateAndSanitizeUrl(rawUrl) {
  if (!rawUrl) {
    return { valid: false, reason: "STAGING_DATABASE_URL is not set" };
  }

  if (rawUrl.includes(FORBIDDEN_PROD_REF)) {
    console.error("================================================================================");
    console.error("FATAL: FORBIDDEN PRODUCTION PROJECT REF DETECTED IN DATABASE URL!");
    console.error(`Ref '${FORBIDDEN_PROD_REF}' is strictly forbidden.`);
    console.error("Execution aborted immediately.");
    console.error("================================================================================");
    process.exit(1);
  }

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1";
    const isDirectStaging = host === `db.${APPROVED_STAGING_REF}.supabase.co`;
    const isApprovedPooler = host.endsWith(".pooler.supabase.com")
      && parsed.username === `postgres.${APPROVED_STAGING_REF}`;
    const isApprovedHost = isLocal || isDirectStaging || isApprovedPooler;

    if (!isApprovedHost) {
      return {
        valid: false,
        reason: `Target connection does not match approved staging ref '${APPROVED_STAGING_REF}' or localhost.`
      };
    }

    return {
      valid: true,
      safeTarget: `${parsed.protocol}//${parsed.username ? parsed.username + "@" : ""}${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`
    };
  } catch (err) {
    return { valid: false, reason: `Malformed database URL: ${err.message}` };
  }
}

export async function runDirectCatalogInspection(dbClient) {
  console.log("=== VECTA Direct Database Catalog & Migration History Inspection ===");

  // 1. Migration History
  console.log("\n--- 1. supabase_migrations.schema_migrations ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT version, name
      FROM supabase_migrations.schema_migrations 
      ORDER BY version ASC;
    `);
    console.log(`  Total applied migrations: ${rows.length}`);
    for (const r of rows) {
      console.log(`    ${r.version} (${r.name ?? "unnamed"})`);
    }
  } catch (err) {
    console.log(`  Notice / Not Available: ${err.message}`);
  }

  // 2. Installed Extensions
  console.log("\n--- 2. pg_extension ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      ORDER BY extname ASC;
    `);
    console.log(`  Installed extensions (${rows.length}):`);
    for (const r of rows) {
      console.log(`    ${r.extname.padEnd(24)} version: ${r.extversion}`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 3. Tables & Views in public schema
  console.log("\n--- 3. pg_class / information_schema (public relations) ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name ASC;
    `);
    console.log(`  Relations in 'public' (${rows.length}):`);
    for (const r of rows) {
      console.log(`    ${r.table_name.padEnd(35)} (${r.table_type})`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 4. Functions (public schema)
  console.log("\n--- 4. pg_proc (public functions count & sample) ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT routine_name, routine_type, data_type 
      FROM information_schema.routines 
      WHERE routine_schema = 'public' 
      ORDER BY routine_name ASC;
    `);
    console.log(`  Total public routines: ${rows.length}`);
    for (const r of rows.slice(0, 20)) {
      console.log(`    ${r.routine_name.padEnd(35)} returns ${r.data_type}`);
    }
    if (rows.length > 20) {
      console.log(`    ... and ${rows.length - 20} more`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 5. Triggers
  console.log("\n--- 5. Triggers on public & auth tables ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT event_object_schema, event_object_table, trigger_name, action_timing, event_manipulation 
      FROM information_schema.triggers 
      WHERE event_object_schema IN ('public', 'auth') 
      ORDER BY event_object_schema, event_object_table, trigger_name;
    `);
    console.log(`  Total triggers found: ${rows.length}`);
    for (const r of rows) {
      console.log(`    ${r.event_object_schema}.${r.event_object_table.padEnd(28)} -> ${r.trigger_name} (${r.action_timing} ${r.event_manipulation})`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 6. RLS Enabled State
  console.log("\n--- 6. Row-Level Security (RLS) Enabled State ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced 
      FROM pg_class c 
      JOIN pg_namespace n ON n.oid = c.relnamespace 
      WHERE n.nspname = 'public' AND c.relkind = 'r' 
      ORDER BY c.relname ASC;
    `);
    console.log(`  Public tables RLS summary (${rows.length}):`);
    for (const r of rows) {
      console.log(`    ${r.table_name.padEnd(35)} RLS=${r.rls_enabled ? "ENABLED" : "DISABLED"} (forced=${r.rls_forced})`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 7. Policies
  console.log("\n--- 7. pg_policies ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT tablename, policyname, permissive, roles, cmd 
      FROM pg_policies 
      WHERE schemaname = 'public' 
      ORDER BY tablename, policyname;
    `);
    console.log(`  Public policies found: ${rows.length}`);
    for (const r of rows.slice(0, 25)) {
      console.log(`    ${r.tablename.padEnd(28)} [${r.cmd}] ${r.policyname}`);
    }
    if (rows.length > 25) {
      console.log(`    ... and ${rows.length - 25} more`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 8. Grants
  console.log("\n--- 8. Table Grants (anon, authenticated, service_role) ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT table_name, grantee, privilege_type 
      FROM information_schema.table_privileges 
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role') 
      ORDER BY table_name, grantee, privilege_type;
    `);
    console.log(`  Public table grants found: ${rows.length}`);
    const summary = {};
    for (const r of rows) {
      const key = `${r.table_name} (${r.grantee})`;
      summary[key] = (summary[key] || []);
      summary[key].push(r.privilege_type);
    }
    for (const [k, v] of Object.entries(summary).slice(0, 20)) {
      console.log(`    ${k.padEnd(38)}: ${v.join(", ")}`);
    }
    if (Object.keys(summary).length > 20) {
      console.log(`    ... and ${Object.keys(summary).length - 20} more`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }

  // 9. cron.job
  console.log("\n--- 9. Scheduled cron jobs (cron.job) ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT jobid, schedule, command, active 
      FROM cron.job 
      ORDER BY jobid ASC;
    `);
    console.log(`  cron.job records (${rows.length}):`);
    for (const r of rows) {
      console.log(`    Job #${r.jobid} [${r.schedule}]: active=${r.active}`);
    }
  } catch (err) {
    console.log(`  cron.job not found or schema inaccessible: ${err.message}`);
  }

  // 10. Storage Schema & Buckets
  console.log("\n--- 10. Storage Schema & Buckets ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT id, name, public, created_at 
      FROM storage.buckets 
      ORDER BY id ASC;
    `);
    console.log(`  storage.buckets (${rows.length}):`);
    for (const r of rows) {
      console.log(`    Bucket '${r.name}' (public=${r.public})`);
    }
  } catch (err) {
    console.log(`  storage.buckets query error: ${err.message}`);
  }

  // 11. Auth & Profile Triggers
  console.log("\n--- 11. Auth / Profile Integration Triggers ---");
  try {
    const { rows } = await dbClient.query(`
      SELECT tgname, relname, proname 
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname IN ('auth', 'public')
        AND (c.relname IN ('users', 'profiles') OR p.proname ILIKE '%user%' OR p.proname ILIKE '%profile%')
      ORDER BY c.relname, tgname;
    `);
    console.log(`  Auth/Profile triggers (${rows.length}):`);
    for (const r of rows) {
      console.log(`    Table '${r.relname}' -> trigger '${r.tgname}' executes function '${r.proname}()'`);
    }
  } catch (err) {
    console.log(`  Error querying pg_trigger: ${err.message}`);
  }

  console.log("\n=== Direct Inspection Complete (100% Read-Only) ===");
}

async function main() {
  const dbUrl = process.env.STAGING_DATABASE_URL || process.env.SUPABASE_DB_URL;
  const validation = validateAndSanitizeUrl(dbUrl);

  if (!validation.valid) {
    console.log("=== VECTA Direct Catalog Inspector ===");
    console.log(`Notice: ${validation.reason}`);
    console.log("\nOPERATOR CONFIGURATION INSTRUCTIONS:");
    console.log("To run direct catalog inspection without revealing credentials:");
    console.log("1. Add the staging-only Postgres connection string to your local .env.local:");
    console.log("   Copy the Session pooler URI from the staging project's Connect dialog (port 5432). Replace its password placeholder locally.");
    console.log("2. Or use Supabase CLI local link / proxy:");
    console.log("   supabase link --project-ref ddlctzbnqewubltcavkh");
    console.log("3. Never commit .env.local (it is ignored by .gitignore).");
    console.log("4. Never print or log the password in any output or terminal recording.");
    console.log("5. Re-run:");
    console.log("   node --env-file=.env.local scripts/staging/direct-catalog-inspect.mjs\n");
    return;
  }

  const { Client } = await loadPgClient();
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  try {
    console.log(`Connecting securely to verified target: ${validation.safeTarget} ...`);
    await client.connect();
    await runDirectCatalogInspection(client);
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error("FATAL:", err.message);
    process.exit(1);
  });
}
