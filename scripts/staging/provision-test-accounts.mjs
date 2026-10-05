#!/usr/bin/env node
// Idempotent staging test-account provisioning (dashboard-review).
//
// Safety: every write is preceded by the gates in lib/run-gates.mjs (exact repo/branch/HEAD, clean tree,
// approved staging ref only, verified TLS, authenticated encrypted backups, migration history, baseline
// counts) plus the env guard in lib/env-guard.mjs. Passwords are generated per account, written ONLY to the
// private credentials file outside the repository, and never printed or logged.
//
// Usage:
//   node --env-file=.env.local scripts/staging/provision-test-accounts.mjs --dry-run
//   node --env-file=.env.local scripts/staging/provision-test-accounts.mjs --live --preflight-only \
//        --run-id=<id> --email-domain=example.invalid --expected-base=<sha>
//   node --env-file=.env.local scripts/staging/provision-test-accounts.mjs --live --run-id=<id> \
//        --email-domain=example.invalid --expected-base=<sha>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { ALL_ROLE_CODES, resolveRoleScope } from "./lib/role-matrix.mjs";
import {
  STATION_VARIANTS, NO_CATERLINK_STATION, NEGATIVE_STATE_STATION, NEGATIVE_LABELS,
  TeamNotEstablishedError, buildAccountPlan, summarizePlan, legacyProfileFor,
} from "./lib/team-plan.mjs";
import {
  gitGates, environmentGates, backupGates, connectVerified, baselineCounts, assertPreWriteBaseline,
  emailFor, defaultCredentialsDir, assertOutsideRepo, secureDirectory,
} from "./lib/run-gates.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const isLive = args.includes("--live");
const isDryRun = !isLive || args.includes("--dry-run");
const preflightOnly = args.includes("--preflight-only");
const runId = argVal("run-id");
const emailDomain = argVal("email-domain");
const expectedBase = argVal("expected-base");
const credentialsDirArg = argVal("credentials-dir");
const REPO_PATH = path.resolve(import.meta.dirname, "../..");

const randomStrongPassword = () => crypto.randomBytes(24).toString("base64url");

async function findAuthUserByEmail(client, email) {
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) return null;
  }
}

// handle_new_user() pre-creates a bare pending profile for every Auth user. Identity and the legacy
// display/compat fields are written here; they are NEVER authority (the assignment is).
async function ensureProfile(client, authUserId, name, staffNo, legacy, status) {
  const fields = { name, staff_no: staffNo, role: legacy.role, station: legacy.station ?? null, team: legacy.team ?? null, status };
  const { data: existing } = await client.from("profiles").select("id").eq("id", authUserId).maybeSingle();
  if (existing) {
    const { error } = await client.from("profiles").update(fields).eq("id", authUserId);
    if (error) throw new Error(`Updating profile failed: ${error.message}`);
    return { id: authUserId, created: false };
  }
  const { error } = await client.from("profiles").insert({ id: authUserId, email: null, ...fields });
  if (error) throw new Error(`Creating profile failed: ${error.message}`);
  return { id: authUserId, created: true };
}

async function ensureEntityMembership(client, profileId, aocId, entityId) {
  const { data: existing, error: e0 } = await client.from("user_entity_memberships").select("id")
    .eq("profile_id", profileId).eq("aoc_id", aocId).eq("operating_entity_id", entityId).eq("status", "active").maybeSingle();
  if (e0) throw new Error(`Membership lookup failed: ${e0.message}`);
  if (existing) return { id: existing.id, created: false };
  const { data, error } = await client.from("user_entity_memberships")
    .insert({ profile_id: profileId, aoc_id: aocId, operating_entity_id: entityId, status: "active", is_primary: true }).select("id").single();
  if (error) throw new Error(`Creating entity membership failed: ${error.message}`);
  return { id: data.id, created: true };
}

async function ensureRoleAssignment(client, profileId, roleDefinitionId, scope, timing) {
  // Reconcile by (profile, role) regardless of revoked/expired state: one assignment per account per run.
  const { data: existing, error: e0 } = await client.from("user_role_assignments").select("id")
    .eq("profile_id", profileId).eq("role_definition_id", roleDefinitionId);
  if (e0) throw new Error(`Assignment lookup failed: ${e0.message}`);
  if (existing && existing.length > 1) throw new Error("More than one assignment exists for this account/role; refusing to guess.");
  if (existing && existing.length === 1) return { id: existing[0].id, created: false };
  const base = { profile_id: profileId, role_definition_id: roleDefinitionId, ...scope, starts_at: timing.starts_at, ends_at: timing.ends_at ?? null };
  let ins = await client.from("user_role_assignments").insert({ ...base, revoked_at: timing.revoked_at ?? null }).select("id").single();
  if (ins.error && timing.revoked_at) {
    // Some validators reject inserting an already-revoked row: create active, then revoke.
    ins = await client.from("user_role_assignments").insert({ ...base, revoked_at: null }).select("id").single();
    if (!ins.error) {
      const up = await client.from("user_role_assignments").update({ revoked_at: timing.revoked_at }).eq("id", ins.data.id);
      if (up.error) throw new Error(`Revoking assignment failed: ${up.error.message}`);
    }
  }
  if (ins.error) throw new Error(`Creating role assignment failed: ${ins.error.message}`);
  return { id: ins.data.id, created: true };
}

function readJson(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

async function main() {
  console.log(`=== VECTA staging provisioning (${isDryRun ? "DRY RUN" : preflightOnly ? "LIVE PREFLIGHT" : "LIVE"}) run id: ${runId ?? "(none)"} ===`);
  const plan = buildAccountPlan();

  if (isDryRun) {
    const sum = summarizePlan(plan);
    console.log(`Inventory: ${sum.base} base + ${sum.stationVariants} station variants + ${sum.negative} negative = ${sum.total}`);
    plan.forEach((a, i) => console.log(`${String(i + 1).padStart(2)} ${a.label.padEnd(26)} ${a.roleCode.padEnd(28)} ${a.accountStatus.padEnd(12)} st=${a.scope.station ?? "-"} hub=${a.scope.hub ?? "-"} team=${a.scope.team ?? "-"}`));
    console.log("No network call was made.");
    return;
  }
  if (!runId || !emailDomain) throw new Error("--run-id and --email-domain are required for --live.");
  if (!expectedBase) throw new Error("--expected-base=<sha> is required for --live.");

  // ---------------- pre-write gates ----------------
  const git = gitGates({ expectedBase, expectedRepoPath: REPO_PATH });
  console.log(`GATE ok: repo path/branch ok, HEAD ${git.head.slice(0, 12)} (authorized base ${expectedBase.slice(0, 12)}; only tooling/tests/docs changed since), clean tree, origin ${git.remote}`);
  const envInfo = environmentGates();
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  if (ctx.projectRef !== envInfo.projectRef) throw new Error("Admin client project mismatch.");
  console.log("GATE ok: environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  console.log(`GATE ok: ${backups.length} encrypted backups authenticate and live outside the repository`);
  const credentialsDir = credentialsDirArg || defaultCredentialsDir(runId);
  assertOutsideRepo(credentialsDir, git.root);
  secureDirectory(credentialsDir);

  const { client: pgc, explicitCa } = await connectVerified();
  let pre;
  try {
    console.log(`GATE ok: verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
    pre = await baselineCounts(pgc, runId);
    const firstRun = pre.runAuthUsers === 0;
    assertPreWriteBaseline(pre, { allowExistingRun: !firstRun });
    if (!firstRun && (pre.runAuthUsers > 36 || pre.runAuthUsers !== pre.runMetadataUsers)) throw new Error("Existing run accounts are inconsistent; refusing.");
    console.log(`GATE ok: ${JSON.stringify({ ...pre })}`);
  } finally {
    await pgc.end();
  }
  if (preflightOnly) { console.log("PREFLIGHT ONLY: nothing was written."); return; }

  // ---------------- provisioning ----------------
  const { client } = ctx;
  const credentialsPath = path.join(credentialsDir, `credentials-${runId}.json`);
  const manifestPath = path.join(credentialsDir, `manifest-${runId}.json`);
  const credentials = readJson(credentialsPath, { runId, accounts: [] });
  const manifest = readJson(manifestPath, { runId, projectRef: ctx.projectRef, accounts: [], runs: [] });
  const run = { at: new Date().toISOString(), created: { auth: 0, profiles: 0, memberships: 0, assignments: 0 }, reconciled: { auth: 0, profiles: 0, memberships: 0, assignments: 0 }, failed: [], blocked: [] };

  const { data: roleRows, error: roleErr } = await client.from("role_definitions").select("id, code");
  if (roleErr) throw new Error(`Could not load role_definitions: ${roleErr.message}`);
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));
  const now = new Date();
  const DAY = 86400000;
  const timingFor = (state) => ({
    revoked: { starts_at: new Date(now - DAY).toISOString(), revoked_at: now.toISOString() },
    expired: { starts_at: new Date(now - 5 * DAY).toISOString(), ends_at: new Date(now - DAY).toISOString() },
    future_dated: { starts_at: new Date(+now + DAY).toISOString() },
  }[state] ?? { starts_at: new Date(now - 60000).toISOString() });
  const profileStatusFor = (state) => ({ pending: "pending", rejected: "rejected", deactivated: "deactivated" }[state] ?? "approved");

  for (const a of plan) {
    const label = a.label;
    const email = emailFor(runId, label, emailDomain);
    try {
      const roleDefId = roleMap.get(a.roleCode);
      if (!roleDefId) throw new Error(`Unknown role code '${a.roleCode}'.`);
      let scope;
      try {
        scope = await resolveRoleScope(client, a.roleCode, a.kind === "base" ? {} : { stationCode: a.scope.station });
      } catch (err) {
        if (err instanceof TeamNotEstablishedError) { run.blocked.push({ label, error: err.message }); console.log(`  BLOCKED  ${label}`); continue; }
        throw err;
      }

      let authUser = await findAuthUserByEmail(client, email);
      let authCreated = false;
      let password = null;
      if (!authUser) {
        password = randomStrongPassword();
        const { data, error } = await client.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { vecta_staging_run_id: runId, vecta_staging_label: label },
        });
        if (error) throw new Error(`createUser failed: ${error.message}`);
        authUser = data.user;
        authCreated = true;
        // Persist the password IMMEDIATELY (before any later step can fail).
        const idx = credentials.accounts.findIndex((c) => c.label === label);
        const rec = { label, email, password, authUserId: authUser.id };
        if (idx >= 0) credentials.accounts[idx] = { ...credentials.accounts[idx], ...rec }; else credentials.accounts.push(rec);
        writeJson(credentialsPath, credentials);
      }

      const profile = await ensureProfile(client, authUser.id, `UAT ${label}`.slice(0, 60), `UAT-${label}`.slice(0, 20), legacyProfileFor(a.roleCode, a.scope), profileStatusFor(a.accountStatus));

      let membership = { id: null, created: false };
      if (scope.entityMembershipNeeded && scope.aoc_id) {
        const { data: entity, error: ee } = await client.from("operating_entities").select("id").eq("aoc_id", scope.aoc_id).eq("code", scope.membershipEntityCode ?? "MAA").single();
        if (ee || !entity) throw new Error("Could not resolve the membership entity.");
        membership = await ensureEntityMembership(client, authUser.id, scope.aoc_id, entity.id);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { entityMembershipNeeded, membershipEntityCode, ...scopeColumns } = scope;
      const assignment = await ensureRoleAssignment(client, authUser.id, roleDefId, { ...scopeColumns, entity_membership_id: membership.id }, timingFor(a.accountStatus));

      const bump = (k, created) => { run[created ? "created" : "reconciled"][k] += 1; };
      bump("auth", authCreated); bump("profiles", authCreated); // the profile row is created with the Auth user by handle_new_user()
      if (membership.id) bump("memberships", membership.created);
      bump("assignments", assignment.created);

      const record = {
        label, kind: a.kind, roleCode: a.roleCode, accountState: a.accountStatus, expectedWorkspace: a.workspace,
        scope: a.scope, email, authUserId: authUser.id, profileId: profile.id, assignmentId: assignment.id,
        membershipId: membership.id, createdThisRun: { auth: authCreated, membership: membership.created, assignment: assignment.created },
      };
      const mi = manifest.accounts.findIndex((m) => m.label === label);
      if (mi >= 0) manifest.accounts[mi] = { ...manifest.accounts[mi], ...record, createdThisRun: manifest.accounts[mi].createdThisRun ?? record.createdThisRun };
      else manifest.accounts.push(record);
      const ci = credentials.accounts.findIndex((c) => c.label === label);
      const existingPw = ci >= 0 ? credentials.accounts[ci].password : null;
      const credRecord = {
        label, email, password: password ?? existingPw ?? "(not available: account pre-existed without a stored password; reset required)",
        roleCode: a.roleCode, expectedWorkspace: a.workspace, scope: a.scope, accountState: a.accountStatus,
        authUserId: authUser.id, profileId: profile.id, assignmentId: assignment.id, membershipId: membership.id,
      };
      if (ci >= 0) credentials.accounts[ci] = credRecord; else credentials.accounts.push(credRecord);
      writeJson(credentialsPath, credentials);
      writeJson(manifestPath, manifest);
      console.log(`  ${authCreated ? "CREATED" : "RECONCILED"}  ${label.padEnd(26)} ${a.roleCode}`);
    } catch (err) {
      run.failed.push({ label, stage: "provision", error: String(err.message).slice(0, 300) });
      console.log(`  FAILED   ${label} -- ${String(err.message).slice(0, 200)}`);
      break; // stop at the first failure; only objects of this run exist
    }
  }

  manifest.runs.push(run);
  writeJson(manifestPath, manifest);
  console.log(`\nCreated: ${JSON.stringify(run.created)}\nReconciled: ${JSON.stringify(run.reconciled)}\nBlocked: ${run.blocked.length}  Failed: ${run.failed.length}`);
  console.log(`Credentials file (passwords never displayed): ${credentialsPath}`);
  console.log(`Run manifest: ${manifestPath}`);
  if (run.failed.length || run.blocked.length) process.exit(2);
}

main().catch((err) => {
  console.error("FATAL:", String(err.message).slice(0, 400));
  process.exit(1);
});
