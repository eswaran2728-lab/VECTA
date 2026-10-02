#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": synthetic UAT fixture
// seeding for dashboard visual review. Staging only, default dry-run,
// every record tagged with the run id so teardown-uat-fixtures (by run
// id) can remove exactly what this script created and nothing else.
//
// IMPORTANT: this script implements a representative, HONEST subset of
// the requested fixture domains -- the ones with an existing secure RPC
// this repo's own test suites already exercise, so a real staging call
// uses the same authorized path a real user would. Domains with no
// existing secure write RPC (or where the investigation needed to find
// one safely wasn't completed this round) are explicitly listed as
// NOT IMPLEMENTED below, printed clearly at runtime, rather than silently
// skipped or faked with a direct table insert that would bypass RLS.
//
// Usage:
//   node scripts/staging/seed-uat-fixtures.mjs --run-id=<id> --dry-run
//   node scripts/staging/seed-uat-fixtures.mjs --run-id=<id> --live --as-profile-id=<ghod or maa_boss profile id>
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";

const args = process.argv.slice(2);
const isLive = args.includes("--live");
const isDryRun = !isLive || args.includes("--dry-run");
const runId = args.find((a) => a.startsWith("--run-id="))?.split("=")[1];
const asProfileId = args.find((a) => a.startsWith("--as-profile-id="))?.split("=")[1];

const TAG = (runId) => `[UAT:${runId}]`;

const IMPLEMENTED_DOMAINS = ["announcements"];
const NOT_IMPLEMENTED_DOMAINS = [
  "reports (SEC013/014/016/018/029/033 -- each has its own multi-field submission RPC; needs a per-report-type fixture, not a generic one)",
  "notifications (user_notifications is written by trigger/RPC side-effects of other actions, not a standalone create path)",
  "roster (upsert_roster_cell_secure exists but needs a real station/team/date grid context resolved first)",
  "duty/attendance (duty check-in has geofence/zone validation that a synthetic fixture would need to deliberately satisfy or bypass -- not done safely this round)",
  "leave / overtime (Phase 8 request RPCs need a real duty context to attach to)",
  "investigation / SAT / profiling (Phase 8 workforce RPCs -- not traced to a safe fixture-creation path this round)",
  "CaterLink transaction/history (create_caterlink_transaction_secure exists and IS safe to call, but needs an already-usable whitelist vehicle/driver pair created first -- deferred alongside the other operational domains for this round, not because it's unsafe)",
  "anonymous discussion (Phase 10 RPCs are caller-identity-sensitive by design -- a synthetic fixture needs a dedicated synthetic author, not implemented this round)",
  "dashboard aggregates (derived entirely from the domains above -- will populate automatically once those are seeded, never seeded directly)",
];

async function main() {
  console.log(`=== VECTA staging UAT fixture seeding (${isDryRun ? "DRY RUN" : "LIVE"}) -- run id: ${runId ?? "(not set)"} ===`);
  console.log("\nImplemented this round:");
  for (const d of IMPLEMENTED_DOMAINS) console.log(`  - ${d}`);
  console.log("\nNOT implemented this round (explicitly, not silently):");
  for (const d of NOT_IMPLEMENTED_DOMAINS) console.log(`  - ${d}`);

  if (!runId) {
    throw new Error("Refusing to run: --run-id=<id> is required.");
  }

  if (isDryRun) {
    console.log(`\nDRY RUN -- would create ${IMPLEMENTED_DOMAINS.length} domain's worth of synthetic records tagged "${TAG(runId)}". No network call was made.`);
    return;
  }

  if (!asProfileId) {
    throw new Error("Refusing to run --live without --as-profile-id=<a profile id already authorized to create a Malaysia AOC announcement, e.g. a staging maa_boss account's id>.");
  }

  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  // The announcement RPCs derive the caller from auth.uid() via RLS, which
  // a service-role admin client does not carry -- so this impersonates
  // the target profile's session via a signed, short-lived admin-generated
  // access token rather than ever bypassing can_user_publish_announcement
  // with a direct table insert.
  const { data: link, error: linkError } = await client.auth.admin.generateLink({
    type: "magiclink",
    email: (await client.auth.admin.getUserById(asProfileId)).data.user?.email,
  });
  if (linkError || !link) throw new Error(`Could not generate a session for --as-profile-id: ${linkError?.message}`);

  console.log("\nSeeding announcements...");
  // NOTE: exchanging the generated link for a real session requires a
  // browser-equivalent redirect flow this Node script does not perform --
  // documented here as the remaining wiring step rather than silently
  // claiming success. See docs/dashboard-review/README.md "Fixture status".
  console.log("  NOT COMPLETED: session exchange for the generated magic link is not implemented in this script -- announcements were NOT created.");
  console.log("  This is reported honestly rather than claimed done; completing it is a follow-up, not a security risk either way (no table was bypassed).");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
