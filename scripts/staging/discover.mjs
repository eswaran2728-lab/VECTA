#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": read-only staging schema
// discovery. Every call here is a GET-equivalent (select/head-count,
// Storage list, Auth Admin list, or the PostgREST OpenAPI root
// description) -- no insert/update/delete/Auth-Admin-write/Storage-write
// call exists in this file. Shares the same env-guard as every other
// staging script.
//
// HONEST LIMITATION, stated once here rather than buried in output:
// this script has ONLY the Supabase REST/Storage/Auth-Admin credential
// (SUPABASE_SECRET_KEY). It has NO direct Postgres connection string and
// NO Supabase Management API token. That means it CANNOT read:
//   - migration history (supabase_migrations.schema_migrations lives
//     outside the `public` schema PostgREST exposes);
//   - installed extensions, triggers, RLS policies, or pg_cron jobs
//     (all pg_catalog/information_schema/cron-schema objects, none of
//     which PostgREST exposes as a table resource).
// Every one of those four items is reported as NOT DISCOVERABLE WITH
// AVAILABLE TOOLING, not guessed, not inferred, not left silently blank.
//
// Usage:
//   node --env-file=.env.local scripts/staging/discover.mjs
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";

async function headCount(client, table) {
  // Use GET with limit(0) instead of head: true because @supabase/postgrest-js
  // converts HTTP 404 responses to HEAD requests with empty bodies into
  // synthetic { status: 204, count: 0, error: null }, causing absent tables
  // to be misreported as existing with 0 rows.
  const { count, error } = await client.from(table).select("*", { count: "exact" }).limit(0);
  if (error) return { exists: false, count: null, error: error.message };
  return { exists: true, count: count ?? 0, error: null };
}

async function fetchOpenApiTableList(url, apiKey) {
  // The PostgREST root endpoint returns an OpenAPI description of every
  // table/view/RPC actually exposed through the REST API in the `public`
  // schema -- a legitimate, read-only, documented way to enumerate
  // exposed objects without a direct Postgres connection. It does NOT
  // reveal row content, triggers, policies, or non-public-schema objects.
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const spec = await res.json();
  const paths = Object.keys(spec.paths ?? {}).map((p) => p.replace(/^\//, ""));
  const definitionNames = Object.keys(spec.definitions ?? spec.components?.schemas ?? {});
  return { ok: true, tables: paths.filter((p) => p && !p.startsWith("rpc/")), rpcs: paths.filter((p) => p.startsWith("rpc/")).map((p) => p.replace("rpc/", "")), definitionNames };
}

const PHASE2_13_TABLES = [
  "aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams",
  "role_definitions", "user_role_assignments", "user_entity_memberships", "user_registration_requests",
  "user_notifications", "central_reports_index", "report_index_queue",
  "overtime_requests", "caterlink_station_capabilities", "catering_companies", "vehicles", "drivers",
  "transactions", "caterlink_checkpoint_hub", "caterlink_archives", "caterlink_transaction_pdfs",
  "discussion_author_mappings", "discussion_identity_resolutions",
  "announcements", "announcement_attachments", "announcement_audit_log", "announcement_acknowledgements",
  "wois_conversations", "wois_messages", "wois_audit_log",
  "phase13_readiness_access_log",
];

const LEGACY_TABLES = [
  "profiles", "stations", "teams", "aircraft_types", "bay_board",
  "report_sec013", "report_sec014", "report_sec014_patrols", "report_sec016", "report_sec018",
  "report_sec018_patrols", "report_sec029", "report_sec029_items", "report_sec033",
  "offload_records", "report_attachments", "report_versions",
  "duty_records", "duty_zones", "team_rosters", "shift_handovers",
  "feedback_threads", "feedback_messages",
  "sat_combined_reports", "sheet_sync_config",
];

async function main() {
  console.log("=== VECTA staging read-only discovery (NO WRITES) ===");
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  console.log("\n--- Items that CANNOT be discovered with the currently configured credential ---");
  console.log("  Migration history (supabase_migrations.schema_migrations): NOT DISCOVERABLE -- requires a direct Postgres connection string or the Supabase CLI/Management API, neither configured.");
  console.log("  Installed extensions (pg_available_extensions / pg_extension): NOT DISCOVERABLE -- same reason.");
  console.log("  Functions/triggers/RLS policies (pg_proc/pg_trigger/pg_policies): NOT DISCOVERABLE -- same reason.");
  console.log("  Scheduled cron jobs (cron.job): NOT DISCOVERABLE -- same reason.");
  console.log("  Schema-version evidence beyond table existence: NOT DISCOVERABLE -- inferred below ONLY from which tables exist, which is a strictly weaker signal than reading schema_migrations directly.");

  console.log("\n--- Tables actually exposed via the REST API (PostgREST OpenAPI root) ---");
  const openApi = await fetchOpenApiTableList(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!openApi.ok) {
    console.log(`  Could not fetch: ${openApi.error}`);
  } else {
    console.log(`  ${openApi.tables.length} table/view(s) exposed: ${openApi.tables.join(", ")}`);
    console.log(`  ${openApi.rpcs.length} RPC(s) exposed: ${openApi.rpcs.length > 0 ? openApi.rpcs.join(", ") : "(none)"}`);
  }

  console.log("\n--- Phase 2-13 table existence + row counts ---");
  for (const table of PHASE2_13_TABLES) {
    const r = await headCount(client, table);
    console.log(`  ${table.padEnd(32)} ${r.exists ? `EXISTS, rows=${r.count}` : `ABSENT (${r.error})`}`);
  }

  console.log("\n--- Legacy (pre-Phase-2) table existence + row counts ---");
  for (const table of LEGACY_TABLES) {
    const r = await headCount(client, table);
    console.log(`  ${table.padEnd(32)} ${r.exists ? `EXISTS, rows=${r.count}` : `ABSENT (${r.error})`}`);
  }

  console.log("\n--- Auth / profile counts ---");
  let authTotal = 0;
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.log(`  Auth users: ERROR ${error.message}`);
      break;
    }
    authTotal += data.users.length;
    if (data.users.length < 200) break;
    page += 1;
  }
  console.log(`  Auth users (count only, no names/emails): ${authTotal}`);

  console.log("\n--- Storage buckets and object counts ---");
  const { data: buckets, error: bucketsError } = await client.storage.listBuckets();
  if (bucketsError) {
    console.log(`  ERROR: ${bucketsError.message}`);
  } else if (!buckets || buckets.length === 0) {
    console.log("  No Storage buckets exist in this project.");
  } else {
    for (const bucket of buckets) {
      const { data: objects, error: listError } = await client.storage.from(bucket.name).list(undefined, { limit: 1000 });
      console.log(`  ${bucket.name.padEnd(28)} public=${bucket.public}  objects=${listError ? `ERROR ${listError.message}` : objects.length}`);
    }
  }

  console.log("\nNo record was created, modified, or deleted. This was read-only discovery only.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
