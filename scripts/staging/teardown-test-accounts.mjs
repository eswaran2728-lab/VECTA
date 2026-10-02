#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": teardown for staging
// test accounts, restricted to the EXACT `vecta.uat.` email prefix this
// repo's own provisioning tool uses. Defaults to --dry-run; never deletes
// anything outside that prefix, regardless of flags.
//
// Usage:
//   node scripts/staging/teardown-test-accounts.mjs --run-id=<id> [--dry-run]
//   node scripts/staging/teardown-test-accounts.mjs --run-id=<id> --live
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";

const EMAIL_PREFIX = "vecta.uat.";

const args = process.argv.slice(2);
const isLive = args.includes("--live");
const isDryRun = !isLive || args.includes("--dry-run");
const runId = args.find((a) => a.startsWith("--run-id="))?.split("=")[1];

async function listAllUsers(client) {
  const users = [];
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < 200) break;
    page += 1;
  }
  return users;
}

async function main() {
  if (!runId) {
    throw new Error("Refusing to run: --run-id=<id> is required. Teardown is always scoped to one provisioning run, never 'all test accounts ever created'.");
  }

  console.log(`=== VECTA staging test-account teardown (${isDryRun ? "DRY RUN" : "LIVE"}) -- run id: ${runId} ===`);

  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  const allUsers = await listAllUsers(client);
  const matching = allUsers.filter((u) => {
    const email = u.email?.toLowerCase() ?? "";
    // Exact prefix AND exact run id, never a loose substring match -- a
    // run id that happens to be a substring of another run id's email
    // must not match (both are separated by '.').
    return email.startsWith(EMAIL_PREFIX) && email.includes(`.${runId.toLowerCase()}@`);
  });

  console.log(`\nFound ${matching.length} account(s) matching prefix "${EMAIL_PREFIX}" and run id "${runId}":`);
  for (const u of matching) {
    console.log(`  - ${u.email} (${u.id})`);
  }

  if (matching.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  if (isDryRun) {
    console.log("\nDRY RUN -- no account was deleted. Re-run with --live to actually delete the accounts listed above.");
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const u of matching) {
    // profiles/user_role_assignments/user_entity_memberships all cascade
    // on profile_id -> auth.users(id) per their own FK definitions
    // (confirmed in the Phase 2/3 migrations) -- deleting the auth user
    // is the single authoritative teardown action, not a separate
    // multi-table delete this script would have to keep in sync.
    const { error } = await client.auth.admin.deleteUser(u.id);
    if (error) {
      failed += 1;
      console.log(`  FAILED  ${u.email}: ${error.message}`);
    } else {
      deleted += 1;
      console.log(`  DELETED ${u.email}`);
    }
  }

  console.log(`\n=== Teardown complete: ${deleted} deleted, ${failed} failed ===`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
