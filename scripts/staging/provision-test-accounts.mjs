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
import {
  STATION_VARIANTS, NO_CATERLINK_STATION, NEGATIVE_STATE_STATION,
  TeamNotEstablishedError, buildAccountPlan, summarizePlan, legacyProfileFor,
} from "./lib/team-plan.mjs";

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

// Station variants, negative states and the no-CaterLink station live in
// lib/team-plan.mjs (single source of truth, unit-tested).

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

// handle_new_user() pre-creates a bare pending profile for every auth user, so the
// row almost always EXISTS already. Set the identity and compatibility display
// fields explicitly: without a name, requireProfile() sends the account to
// /avsec/profile-setup. The legacy role/station/team written here are
// compatibility/display data only -- access is decided by the assignment.
async function ensureProfile(client, authUserId, name, staffNo, legacy, status) {
  const fields = { name, staff_no: staffNo, role: legacy.role, station: legacy.station ?? null, team: legacy.team ?? null, status };
  const { data: existing } = await client.from("profiles").select("id").eq("id", authUserId).maybeSingle();
  if (existing) {
    const { error } = await client.from("profiles").update(fields).eq("id", authUserId);
    if (error) throw new Error(`Updating existing profile failed: ${error.message}`);
    return;
  }
  const { error } = await client.from("profiles").insert({ id: authUserId, email: null, ...fields });
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
    const plan = buildAccountPlan();
    const sum = summarizePlan(plan);
    console.log(`\nExact account inventory: ${sum.base} base + ${sum.stationVariants} station variants + ${sum.negative} negative-state = ${sum.total} accounts (Malaysia AOC only; no foreign-AOC account).`);
    console.log(`Availability: ready now ${sum.readyNow}; need the approved team seed first ${sum.needsTeamSeed}.`);
    console.log("\n#  label                 role                         aoc entity dept         unit          hub                  station    team   membership status");
    plan.forEach((a, i) => {
      const sc = a.scope;
      console.log(`${String(i + 1).padStart(2)} ${a.label.padEnd(21)} ${a.roleCode.padEnd(28)} ${(sc.aoc ?? "-").padEnd(3)} ${(sc.entity ?? "-").padEnd(6)} ${(sc.department ?? "-").padEnd(12)} ${(sc.unit ?? "-").padEnd(13)} ${(sc.hub ?? "-").padEnd(20)} ${(sc.station ?? "-").padEnd(10)} ${(sc.team ?? "-").padEnd(6)} ${(sc.membership ?? "none").padEnd(10)} ${a.status}${a.accountStatus !== "approved" ? ` [${a.accountStatus}]` : ""}`);
      console.log(`      login: ${a.loginState}; workspace: ${a.workspace}`);
      console.log(`      allowed: ${a.allowed.join("; ") || "-"} | denied: ${a.denied.join("; ")}`);
    });
    console.log("\nNo network call was made. Re-run with --live --email-domain=<operator-approved-domain> after the project identity, mailbox strategy and team seed are explicitly confirmed.");
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
  let blockedCount = 0;

  async function resolveOrBlock(label, roleCode, opts) {
    try {
      return await resolveRoleScope(client, roleCode, opts);
    } catch (err) {
      if (err instanceof TeamNotEstablishedError) {
        blockedCount += 1;
        appendManifest(manifestPath, { label, roleCode, status: "blocked", error: err.message });
        console.log(`  BLOCKED  ${label.padEnd(28)} ${roleCode} -- ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  const planByLabel = new Map(buildAccountPlan().map((a) => [a.label, a]));

  async function provisionOne(label, roleCode, { scopeOverride, timing, status = "approved" } = {}) {
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

      const planned = planByLabel.get(label);
      if (!planned) throw new Error(`No planned account named '${label}'.`);
      await ensureProfile(client, authUser.id, `UAT ${label}`, `UAT-${label}`.slice(0, 20), legacyProfileFor(roleCode, planned.scope), status);

      const roleDefId = roleMap.get(roleCode);
      if (!roleDefId) throw new Error(`Unknown role code '${roleCode}' -- not found in role_definitions.`);

      let scope = scopeOverride;
      if (!scope) {
        scope = await resolveOrBlock(label, roleCode, {});
        if (!scope) return;
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
      const scope = await resolveOrBlock(`${stationRole}-${variant.label}`, stationRole, { stationCode: variant.stationCode });
      if (!scope) continue;
      await provisionOne(`${stationRole}-${variant.label}`, stationRole, { scopeOverride: scope, timing: { starts_at: now.toISOString() } });
    }
  }

  console.log("\n--- Station variant with no CaterLink scanning ---");
  const { data: ncRow } = await client.from("org_stations").select("id").eq("code", NO_CATERLINK_STATION).maybeSingle();
  const { data: ncCap } = ncRow ? await client.from("caterlink_station_capabilities").select("id").eq("station_id", ncRow.id).limit(1) : { data: null };
  if (!ncRow || (ncCap && ncCap.length > 0)) {
    console.log(`  SKIPPED  configured no-CaterLink station '${NO_CATERLINK_STATION}' is missing or now has a capability row -- nothing created for this variant.`);
  } else {
    const scope = await resolveOrBlock("aso-no-caterlink", "aso", { stationCode: NO_CATERLINK_STATION });
    if (scope) await provisionOne("aso-no-caterlink", "aso", { scopeOverride: scope, timing: { starts_at: now.toISOString() } });
  }

  console.log("\n--- Negative-state accounts (each a separate, dedicated test account) ---");
  const asoScope = await resolveOrBlock("negative-states", "aso", { stationCode: NEGATIVE_STATE_STATION });
  if (!asoScope) {
    console.log("  SKIPPED  negative-state accounts need the established team at the negative-state station.");
  } else {
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
  await provisionOne("neg-future-dated", "aso", { scopeOverride: asoScope, timing: { starts_at: new Date(now.getTime() + 86400000).toISOString() } });

  }

  fs.writeFileSync(credentialsPath, JSON.stringify({ runId, generatedAt: new Date().toISOString(), accounts: credentials }, null, 2), { mode: 0o600 });

  console.log(`\n=== Provisioning complete: ${createdCount} created, ${skippedCount} already existed, ${blockedCount} blocked (team not established), ${failedCount} failed ===`);
  console.log(`Credentials file (passwords included -- never displayed here): ${credentialsPath}`);
  console.log(`Recovery manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
