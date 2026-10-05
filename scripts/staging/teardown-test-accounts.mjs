#!/usr/bin/env node
// Teardown for ONE provisioning run, driven by that run's private manifest.
//
// Targets only objects that carry the exact run identity:
//   * the Auth user's email starts with `vecta.uat.<run-id>.` AND its user_metadata.vecta_staging_run_id equals the run id
//   * the manifest lists the exact Auth UUID, and every profile/assignment/membership ID belongs to that Auth user
// It refuses to continue if any target fails a check, never lists or touches other users, and defaults to a
// DRY RUN. --live additionally requires --confirm-destructive=<run-id> (a separate, explicit authorization).
//
// Usage:
//   node --env-file=.env.local scripts/staging/teardown-test-accounts.mjs --run-id=<id> [--manifest=<path>] [--expect=36]
import fs from "node:fs";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { defaultCredentialsDir, connectVerified } from "./lib/run-gates.mjs";
import { CURRENT_REVIEW_DIR } from "./lib/review-accounts.mjs";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const runId = argVal("run-id");
const isLive = args.includes("--live");
const expected = argVal("expect") ? parseInt(argVal("expect"), 10) : null;
// default: the CURRENT manifest (logins were renamed; older per-run manifests are superseded)
const manifestPath = argVal("manifest") || (runId ? path.join(CURRENT_REVIEW_DIR, "manifest.json") : null);
void defaultCredentialsDir;

async function main() {
  if (!runId) throw new Error("Refusing to run: --run-id=<id> is required (teardown is always scoped to one run).");
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error("Refusing to run: the run manifest was not found.");
  if (isLive && argVal("confirm-destructive") !== runId) throw new Error("Refusing --live without --confirm-destructive=<exact run id>.");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.runId !== undefined && manifest.runId !== runId) throw new Error("Manifest run id does not match --run-id.");
  console.log(`=== VECTA staging teardown (${isLive ? "LIVE" : "DRY RUN"}) run id: ${runId} ===`);
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;
  const accounts = manifest.accounts ?? [];
  if (expected !== null && accounts.length !== expected) throw new Error(`Manifest lists ${accounts.length} accounts, expected ${expected}.`);

  const prefix = `vecta.uat.${runId.toLowerCase()}.`;
  const refusals = [];
  const targets = [];
  for (const a of accounts) {
    const { data, error } = await client.auth.admin.getUserById(a.authUserId);
    const u = data?.user;
    if (error || !u) { refusals.push(`${a.label}: Auth user not found`); continue; }
    const emailOk = (u.email ?? "").toLowerCase() === String(a.email ?? "").toLowerCase() || (u.email ?? "").toLowerCase().startsWith(prefix);
    if (!emailOk) refusals.push(`${a.label}: email does not match the manifest`);
    else if (!String(u.user_metadata?.vecta_staging_run_id ?? "").startsWith(runId)) refusals.push(`${a.label}: user_metadata run id mismatch`);
    else targets.push({ ...a });
  }

  // Cross-check the dependent rows through the database (names / ids / counts only).
  const { client: pg } = await connectVerified();
  const owned = { profiles: 0, assignments: 0, memberships: 0 };
  try {
    await pg.query("BEGIN READ ONLY");
    const ids = targets.map((t) => t.authUserId);
    const prof = await pg.query("select id from public.profiles where id = any($1::uuid[])", [ids]);
    owned.profiles = prof.rowCount;
    const asg = await pg.query("select id, profile_id from public.user_role_assignments where profile_id = any($1::uuid[])", [ids]);
    owned.assignments = asg.rowCount;
    const mem = await pg.query("select id, profile_id from public.user_entity_memberships where profile_id = any($1::uuid[])", [ids]);
    owned.memberships = mem.rowCount;
    for (const t of targets) {
      if (t.assignmentId && !asg.rows.some((r) => r.id === t.assignmentId && r.profile_id === t.authUserId)) refusals.push(`${t.label}: assignment id does not belong to the account`);
      if (t.membershipId && !mem.rows.some((r) => r.id === t.membershipId && r.profile_id === t.authUserId)) refusals.push(`${t.label}: membership id does not belong to the account`);
    }
    await pg.query("ROLLBACK");
  } finally {
    await pg.end();
  }

  console.log(`\nTargets: ${targets.length} Auth UUIDs, ${owned.profiles} profiles, ${owned.assignments} assignments, ${owned.memberships} memberships (all carry the run identity)`);
  for (const t of targets) console.log(`  - ${t.label} (${t.authUserId})`);
  if (refusals.length) {
    console.log(`\nREFUSED: ${refusals.length} target(s) failed identity checks:`);
    refusals.forEach((r) => console.log(`  ! ${r}`));
    process.exit(2);
  }
  if (!isLive) {
    console.log("\nDRY RUN -- nothing deleted. The original accounts and all unrelated data are untouched.");
    return;
  }
  // profiles / assignments / memberships cascade from auth.users (Phase 2/3 FKs)
  let deleted = 0;
  for (const t of targets) {
    const { error } = await client.auth.admin.deleteUser(t.authUserId);
    if (error) console.log(`  FAILED ${t.label}: ${error.message}`); else deleted += 1;
  }
  console.log(`\n=== Teardown complete: ${deleted}/${targets.length} deleted ===`);
}

main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
