#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": read-only staging
// preflight. Performs ONLY `select`/count-style reads -- no insert,
// update, delete, or Auth Admin write call exists anywhere in this file.
// Shares the exact same safety gate as every other script in this
// directory (lib/env-guard.mjs) -- it still requires
// VECTA_ALLOW_STAGING_PROVISIONING=true and an exact
// VECTA_APPROVED_STAGING_PROJECT_REF match, even though it writes
// nothing, so a preflight run is never mistaken for a weaker/implicitly
// safe mode that skips project-identity confirmation.
//
// Usage:
//   node scripts/staging/preflight.mjs
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { ALL_ROLE_CODES } from "./lib/role-matrix.mjs";

async function countTable(client, table, filter) {
  let query = client.from(table).select("*", { count: "exact", head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) return { count: null, error: error.message };
  return { count, error: null };
}

async function countAuthUsers(client) {
  // Auth Admin has no head-count endpoint; page through listUsers and sum
  // -- still read-only (GET-equivalent), no write.
  let total = 0;
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return { count: null, error: error.message };
    total += data.users.length;
    if (data.users.length < 200) break;
    page += 1;
  }
  return { count: total, error: null };
}

async function main() {
  console.log("=== VECTA staging read-only preflight (NO WRITES) ===");

  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  const results = {};

  results.authUsers = await countAuthUsers(client);
  results.profiles = await countTable(client, "profiles");
  results.activeAssignments = await countTable(client, "user_role_assignments", (q) => q.is("revoked_at", null));
  results.entityMemberships = await countTable(client, "user_entity_memberships", (q) => q.eq("status", "active"));
  results.centralReportsIndex = await countTable(client, "central_reports_index");
  results.caterlinkTransactions = await countTable(client, "transactions");
  results.announcementAttachments = await countTable(client, "announcement_attachments");

  console.log("\n--- Preflight counts ---");
  for (const [label, { count, error }] of Object.entries(results)) {
    console.log(`  ${label.padEnd(24)} ${error ? `ERROR: ${error}` : count}`);
  }

  console.log("\n--- Role definitions ---");
  const { data: roleRows, error: roleError } = await client.from("role_definitions").select("code, is_active");
  if (roleError) {
    console.log(`  ERROR: ${roleError.message}`);
  } else {
    const approvedCodes = roleRows.filter((r) => r.is_active).map((r) => r.code);
    const uniqueApproved = new Set(approvedCodes);
    console.log(`  Active role_definitions rows: ${roleRows.filter((r) => r.is_active).length}`);
    console.log(`  Unique active role codes: ${uniqueApproved.size}`);

    const expected = new Set(ALL_ROLE_CODES);
    const missingFromDb = ALL_ROLE_CODES.filter((c) => !uniqueApproved.has(c));
    const extraInDb = [...uniqueApproved].filter((c) => !expected.has(c));
    if (missingFromDb.length > 0) {
      console.log(`  MISSING from this project's role_definitions (provisioning for these roles WILL fail): ${missingFromDb.join(", ")}`);
    }
    if (extraInDb.length > 0) {
      console.log(`  Present in this project but not in the staging role matrix (informational only): ${extraInDb.join(", ")}`);
    }
    if (missingFromDb.length === 0 && extraInDb.length === 0) {
      console.log("  MATCH: this project's active role_definitions are exactly the 23 roles the staging matrix expects.");
    }
  }

  console.log("\n--- Schema/migration prerequisite spot-check ---");
  const prereqTables = [
    "aocs",
    "operating_entities",
    "departments",
    "units",
    "hubs",
    "org_stations",
    "org_teams",
    "role_definitions",
    "user_role_assignments",
    "user_entity_memberships",
    "profiles",
    "caterlink_station_capabilities",
  ];
  const missingTables = [];
  for (const table of prereqTables) {
    const { error } = await client.from(table).select("*", { count: "exact", head: true }).limit(1);
    if (error) missingTables.push(`${table} (${error.message})`);
  }
  if (missingTables.length > 0) {
    console.log(`  MISSING/INACCESSIBLE prerequisite table(s) -- provisioning cannot proceed until these are resolved:\n    ${missingTables.join("\n    ")}`);
  } else {
    console.log("  All prerequisite tables for provisioning are present and selectable.");
  }

  console.log("\nNo record was created, modified, or deleted. This was a read-only preflight only.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
