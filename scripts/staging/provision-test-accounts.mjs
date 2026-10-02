#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": idempotent staging
// test-account provisioning tool.
//
// SAFETY: refuses to run at all unless VECTA_ALLOW_STAGING_PROVISIONING=true
// AND VECTA_APPROVED_STAGING_PROJECT_REF exactly matches the project
// NEXT_PUBLIC_SUPABASE_URL resolves to AND SUPABASE_SERVICE_ROLE_KEY is set
// (see lib/env-guard.mjs -- every check lives there, not duplicated here).
//
// Usage:
//   node scripts/staging/provision-test-accounts.mjs --dry-run
//   node scripts/staging/provision-test-accounts.mjs --live --email-domain=<operator-approved-domain>
//
// --dry-run (default): prints exactly what would be created/skipped, makes
//   NO network call at all -- safe to run with no credentials configured.
// --live: performs the real Supabase Admin API calls. Requires
//   --email-domain to be passed explicitly (this script never invents or
//   defaults a mailbox domain -- the operator must confirm the strategy).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { ALL_ROLE_CODES, resolveRoleScope } from "./lib/role-matrix.mjs";

const args = process.argv.slice(2);
const isLive = args.includes("--live");
const isDryRun = !isLive || args.includes("--dry-run");
const runId = (args.find((a) => a.startsWith("--run-id=")) || `--run-id=uat${Date.now().toString(36)}`).split("=")[1];
const emailDomainArg = args.find((a) => a.startsWith("--email-domain="))?.split("=")[1];
const credentialsDirArg = args.find((a) => a.startsWith("--credentials-dir="))?.split("=")[1];

function randomStrongPassword() {
  // 24 bytes of entropy, base64url-encoded -> 32 chars, well above 20.
  return crypto.randomBytes(24).toString("base64url");
}

// Station-role variants, labeled as ADDITIONAL accounts beyond the base
// 23 -- deliberately excludes PEN. resolveRoleScope()'s own default
// station for sso/so/aso (lib/role-matrix.mjs) is already 'PEN', so the
// base positive-role accounts for sso/so/aso are already PEN-scoped; a
// separate "pen" variant would be a redundant, not-truly-additional
// account covering the same station the base accounts already cover
// (confirmed and corrected during the staging reconciliation round --
// see docs/dashboard-review/README.md "Corrected account-plan
// arithmetic"). KUL and JHB remain genuinely additional: the base
// accounts never resolve to either of those stations for sso/so/aso.
const STATION_VARIANTS = [
  { label: "kul", stationCode: "KUL - MAA" },
  { label: "jhb", stationCode: "JHB" },
];

// Negative-state accounts: each is its OWN dedicated test account, never a
// positive account reused in a bad state.
const NEGATIVE_STATES = ["pending", "rejected", "deactivated", "revoked", "expired", "future_dated", "foreign_aoc"];

function buildEmail(domain, label, runIdValue) {
  return `vecta.uat.${label}.${runIdValue}@${domain}`.toLowerCase();
}

async function findExistingAuthUserByEmail(client, email) {
  // Supabase Admin API has no "get by email" filter on listUsers in all
  // versions, so we page through -- staging account volumes here are
  // small (tens, not thousands) by construction.
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function ensureProfile(client, authUserId, name, staffNo, legacyRole, status) {
  const { data: existing } = await client.from("profiles").select("id").eq("id", authUserId).maybeSingle();
  if (existing) {
    const { error } = await client.from("profiles").update({ status }).eq("id", authUserId);
    if (error) throw new Error(`Updating existing profile failed: ${error.message}`);
    return;
  }
  const { error } = await client.from("profiles").insert({
    id: authUserId,
    email: null, // profiles.email is a legacy mirror column on some schemas; left null here, auth.users is authoritative
    name,
    staff_no: staffNo,
    role: legacyRole,
    status,
  });
  if (error) throw new Error(`Creating profile failed: ${error.message}`);
}

async function ensureEntityMembership(client, profileId, aocId, entityId) {
  const { data: existing } = await client
    .from("user_entity_memberships")
    .select("id")
    .eq("profile_id", profileId)
    .eq("aoc_id", aocId)
    .eq("operating_entity_id", entityId)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await client
    .from("user_entity_memberships")
    .insert({ profile_id: profileId, aoc_id: aocId, operating_entity_id: entityId, status: "active", is_primary: true })
    .select("id")
    .single();
  if (error) throw new Error(`Creating entity membership failed: ${error.message}`);
  return created.id;
}

async function ensureRoleAssignment(client, profileId, roleDefinitionId, scope, timing) {
  const { data: existing } = await client
    .from("user_role_assignments")
    .select("id")
    .eq("profile_id", profileId)
    .eq("role_definition_id", roleDefinitionId)
    .is("revoked_at", timing.revoked_at ?? null)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await client
    .from("user_role_assignments")
    .insert({
      profile_id: profileId,
      role_definition_id: roleDefinitionId,
      ...scope,
      starts_at: timing.starts_at,
      ends_at: timing.ends_at ?? null,
      revoked_at: timing.revoked_at ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Creating role assignment failed: ${error.message}`);
  return created.id;
}

function appendManifest(manifestPath, entry) {
  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { runId, entries: [] };
  existing.entries.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(manifestPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

async function main() {
  console.log(`=== VECTA staging test-account provisioning (${isDryRun ? "DRY RUN" : "LIVE"}) -- run id: ${runId} ===`);

  if (isDryRun) {
    console.log("\nPlanned positive-role accounts:");
    for (const role of ALL_ROLE_CODES) {
      console.log(`  - ${role}`);
    }
    console.log("\nPlanned station-role variants (kul/jhb/no-CaterLink-station -- PEN excluded, already covered by the base accounts' own default station):");
    for (const v of STATION_VARIANTS) console.log(`  - sso/so/aso @ ${v.label}`);
    console.log("  - sso/so/aso @ a station with no caterlink_station_capabilities row (resolved at run time, --live only)");
    console.log("\nPlanned negative-state accounts (each its own dedicated account):");
    for (const s of NEGATIVE_STATES) console.log(`  - ${s}`);
    console.log("\nNo network call was made. Re-run with --live --email-domain=<operator-approved-domain> after the project identity and mailbox strategy are both explicitly confirmed.");
    return;
  }

  if (!emailDomainArg) {
    throw new Error("Refusing to run --live without --email-domain=<operator-approved-domain>. This script never invents a mailbox domain.");
  }

  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  const credentialsDir = credentialsDirArg || path.join(os.tmpdir(), "vecta-staging-credentials");
  fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  const credentialsPath = path.join(credentialsDir, `staging-credentials-${runId}.json`);
  const manifestPath = path.join(credentialsDir, `staging-manifest-${runId}.json`);
  console.log(`\nCredentials will be written to: ${credentialsPath} (outside the repository; gitignored defensively even if ever created inside it)`);

  const { data: roleRows, error: roleErr } = await client.from("role_definitions").select("id, code");
  if (roleErr) throw new Error(`Could not load role_definitions: ${roleErr.message}`);
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

  const credentials = [];
  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  async function provisionOne(label, roleCode, { scopeOverride, timing, status = "approved", legacyRole = "ASO" } = {}) {
    const email = buildEmail(emailDomainArg, label, runId);
    try {
      let authUser = await findExistingAuthUserByEmail(client, email);
      let created = false;
      let password = null;
      if (!authUser) {
        password = randomStrongPassword();
        const { data, error } = await client.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { vecta_staging_run_id: runId, vecta_staging_label: label },
        });
        if (error) throw new Error(error.message);
        authUser = data.user;
        created = true;
      }

      await ensureProfile(client, authUser.id, `UAT ${label}`, `UAT-${label}`.slice(0, 20), legacyRole, status);

      const roleDefId = roleMap.get(roleCode);
      if (!roleDefId) throw new Error(`Unknown role code '${roleCode}' -- not found in role_definitions.`);

      let scope = scopeOverride;
      if (!scope) {
        scope = await resolveRoleScope(client, roleCode);
      }

      let entityMembershipId = null;
      if (scope.entityMembershipNeeded && scope.aoc_id) {
        const { data: entity } = await client.from("operating_entities").select("id").eq("aoc_id", scope.aoc_id).eq("code", scope.membershipEntityCode ?? "MAA").single();
        entityMembershipId = await ensureEntityMembership(client, authUser.id, scope.aoc_id, entity.id);
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { entityMembershipNeeded, membershipEntityCode, ...scopeColumns } = scope;
      await ensureRoleAssignment(client, authUser.id, roleDefId, { ...scopeColumns, entity_membership_id: entityMembershipId }, timing);

      appendManifest(manifestPath, { label, roleCode, email, authUserId: authUser.id, created, status: "ok" });
      credentials.push({ role: roleCode, label, email, password: created ? password : "(already existed -- password not reissued)", ...scope, status });
      if (created) createdCount += 1;
      else skippedCount += 1;
      console.log(`  ${created ? "CREATED" : "EXISTS "}  ${label.padEnd(28)} ${roleCode}`);
    } catch (err) {
      failedCount += 1;
      appendManifest(manifestPath, { label, roleCode, email, status: "failed", error: err.message });
      console.log(`  FAILED   ${label.padEnd(28)} ${roleCode} -- ${err.message}`);
    }
  }

  console.log("\n--- Positive-role accounts ---");
  const now = new Date();
  for (const roleCode of ALL_ROLE_CODES) {
    await provisionOne(roleCode, roleCode, { timing: { starts_at: now.toISOString() } });
  }

  console.log("\n--- Station-role variants ---");
  for (const variant of STATION_VARIANTS) {
    for (const stationRole of ["sso", "so", "aso"]) {
      const scope = await resolveRoleScope(client, stationRole, { stationCode: variant.stationCode, teamName: `UAT-${variant.label}` });
      await provisionOne(`${stationRole}-${variant.label}`, stationRole, { scopeOverride: scope, timing: { starts_at: now.toISOString() } });
    }
  }

  console.log("\n--- Station variant with no CaterLink scanning ---");
  const { data: noCaterlinkStation } = await client
    .from("org_stations")
    .select("code")
    .not("id", "in", `(select station_id from caterlink_station_capabilities where station_id is not null)`)
    .limit(1)
    .maybeSingle();
  if (noCaterlinkStation) {
    const scope = await resolveRoleScope(client, "aso", { stationCode: noCaterlinkStation.code, teamName: "UAT-no-caterlink" });
    await provisionOne("aso-no-caterlink", "aso", { scopeOverride: scope, timing: { starts_at: now.toISOString() } });
  } else {
    console.log("  SKIPPED  no station without CaterLink capability was found -- nothing created for this variant.");
  }

  console.log("\n--- Negative-state accounts (each a separate, dedicated test account) ---");
  const asoScope = await resolveRoleScope(client, "aso", { teamName: "UAT-negative" });
  await provisionOne("neg-pending", "aso", { scopeOverride: asoScope, status: "pending", timing: { starts_at: now.toISOString() } });
  await provisionOne("neg-rejected", "aso", { scopeOverride: asoScope, status: "rejected", timing: { starts_at: now.toISOString() } });
  await provisionOne("neg-deactivated", "aso", { scopeOverride: asoScope, status: "deactivated", timing: { starts_at: now.toISOString() } });
  await provisionOne("neg-revoked", "aso", {
    scopeOverride: asoScope,
    timing: { starts_at: new Date(now.getTime() - 86400000).toISOString(), revoked_at: now.toISOString() },
  });
  await provisionOne("neg-expired", "aso", {
    scopeOverride: asoScope,
    timing: { starts_at: new Date(now.getTime() - 5 * 86400000).toISOString(), ends_at: new Date(now.getTime() - 86400000).toISOString() },
  });
  await provisionOne("neg-future", "aso", { scopeOverride: asoScope, timing: { starts_at: new Date(now.getTime() + 86400000).toISOString() } });

  const { data: foreignAoc } = await client.from("aocs").select("id, code").neq("code", "MY").eq("is_active", true).limit(1).maybeSingle();
  if (foreignAoc) {
    await provisionOne("neg-foreign-aoc", "aso", {
      scopeOverride: { aoc_id: foreignAoc.id, operating_entity_id: null, department_id: asoScope.department_id, unit_id: null, hub_id: asoScope.hub_id, station_id: asoScope.station_id, team_id: asoScope.team_id, entityMembershipNeeded: true },
      timing: { starts_at: now.toISOString() },
    });
  } else {
    console.log("  SKIPPED  no active non-Malaysia AOC exists in this project -- the foreign-AOC negative-state account was not created. This is NOT a schema change this script will ever perform; create one yourself first if that scenario is required.");
  }

  fs.writeFileSync(credentialsPath, JSON.stringify({ runId, generatedAt: new Date().toISOString(), accounts: credentials }, null, 2), { mode: 0o600 });

  console.log(`\n=== Provisioning complete: ${createdCount} created, ${skippedCount} already existed, ${failedCount} failed ===`);
  console.log(`Credentials file (passwords included -- never displayed here): ${credentialsPath}`);
  console.log(`Recovery manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
