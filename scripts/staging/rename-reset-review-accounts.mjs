#!/usr/bin/env node
// Renames the dashboard-review accounts to simple role-based logins and sets ONE shared staging password, IN PLACE
// (the Auth user ids, assignments, memberships, profile/account status and negative-state conditions are preserved;
// nothing is deleted or recreated). Accounts are identified ONLY by the immutable Auth user id recorded in the private
// review manifests, and each must also carry the review run id in its Auth metadata.
//
// Safety: approved staging project only (env guard + run gates); the 16 unrelated legacy accounts and anything not in
// the manifests are never touched; every destination email is checked for collisions BEFORE any change; the shared
// password comes from the environment (VECTA_REVIEW_SHARED_PASSWORD) and is never printed, logged or committed. The
// outputs (updated credentials, mapping, manifest) go to a private directory outside the repository, and the old per-run
// credential/manifest files are renamed SUPERSEDED-* so no tool can keep using them. Resumable and idempotent: a state
// file records each account once it is fully done; a re-run skips done accounts and retries the rest.
//
// Usage: VECTA_REVIEW_SHARED_PASSWORD=... node --env-file=.env.local scripts/staging/rename-reset-review-accounts.mjs \
//          --expected-base=<sha> [--dry-run]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { gitGates, environmentGates, assertOutsideRepo, secureDirectory, defaultCredentialsDir } from "./lib/run-gates.mjs";

const DOMAIN = "vecta.test";
// label -> simple login. Roles with a station variant carry the station; negative states carry the state.
export const LOGIN_BY_LABEL = {
  airasia_management: "airasia.management",
  ghod: "ghod",
  global_reporting_controller: "global.reporting",
  super_admin: "super.admin",
  maa_boss: "maa.boss",
  maa_admin: "maa.admin",
  aax_boss: "aax.boss",
  aax_admin: "aax.admin",
  operation_manager: "operation",
  main_enforcement: "enforcement",
  compliance: "compliance",
  caterlink_management: "caterlink.management",
  investigation_sso: "investigation.sso",
  investigation_so: "investigation.so",
  investigation_aso: "investigation.aso",
  sat_aso: "sat.aso",
  profiling_so: "profiling.so",
  profiling_aso: "profiling.aso",
  hub_se: "hub.se",
  dse: "dse",
  sso: "sso.pen",
  so: "so.pen",
  aso: "aso.pen",
  "sso-kul": "sso.kul",
  "so-kul": "so.kul",
  "aso-kul": "aso.kul",
  "sso-jhb": "sso.jhb",
  "so-jhb": "so.jhb",
  "aso-jhb": "aso.jhb",
  "aso-no-caterlink": "aso.btu",
  "neg-pending-profile": "pending.profile",
  "neg-rejected-profile": "rejected.profile",
  "neg-deactivated-profile": "deactivated.profile",
  "neg-revoked-assignment": "revoked.assignment",
  "neg-expired-assignment": "expired.assignment",
  "neg-future-assignment": "future.assignment",
  "aso-kch-receipt": "aso.kch",
  "aso-bki-receipt": "aso.bki",
  "caterlink-driver": "caterlink.driver",
  "caterlink-vendor": "caterlink.vendor",
};
export const emailForLabel = (label) => `${LOGIN_BY_LABEL[label]}@${DOMAIN}`;

const RUNS = ["dashboard-review-20261005", "dashboard-review-20261005-receipt", "dashboard-review-20261005-caterlink"];
const CURRENT_DIR = path.join(os.tmpdir(), "vecta-staging-credentials", "vecta-review-current");
const STATE_PATH = path.join(CURRENT_DIR, "rename-state.json");
const CRED_PATH = path.join(CURRENT_DIR, "credentials.json");
const MANIFEST_PATH = path.join(CURRENT_DIR, "manifest.json");
const MAPPING_PATH = path.join(CURRENT_DIR, "old-to-new-mapping.json");

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const expectedBase = argVal("expected-base");
const REPO_PATH = path.resolve(import.meta.dirname, "../..");
const readJson = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb);
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 });

function loadLegacy() {
  // On the first run the per-run files are authoritative; afterwards they are renamed SUPERSEDED-* and the current
  // manifest/credentials (written by this script) are used instead.
  const out = [];
  for (const run of RUNS) {
    const dir = defaultCredentialsDir(run);
    const credFile = path.join(dir, `credentials-${run}.json`);
    const manFile = path.join(dir, `manifest-${run}.json`);
    if (!fs.existsSync(credFile) || !fs.existsSync(manFile)) continue;
    const creds = readJson(credFile, { accounts: [] }).accounts;
    for (const m of readJson(manFile, { accounts: [] }).accounts) {
      const c = creds.find((x) => x.label === m.label) ?? {};
      out.push({ run, ...m, display: m.display ?? c.display ?? m.roleCode ?? m.label, previousEmail: m.email, previousPassword: c.password ? "(stored)" : "(none)" });
    }
  }
  return out;
}

async function main() {
  const password = process.env.VECTA_REVIEW_SHARED_PASSWORD;
  if (!password || password.length < 12) throw new Error("VECTA_REVIEW_SHARED_PASSWORD is not set (or too short).");
  const git = gitGates({ expectedBase, expectedRepoPath: REPO_PATH, extraAllowed: [/^supabase\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/, /^\.vercelignore$/] });
  console.log(`GATE ok: repo/branch ok, HEAD ${git.head.slice(0, 12)}, clean tree, origin ${git.remote}`);
  environmentGates();
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  assertOutsideRepo(CURRENT_DIR, git.root);
  secureDirectory(CURRENT_DIR);
  const { client } = ctx;

  // ---- the exact account set, by immutable Auth id ----
  let state = readJson(STATE_PATH, { accounts: {} });
  const current = readJson(MANIFEST_PATH, null);
  const accounts = current ? current.accounts.map((a) => ({ ...a })) : loadLegacy();
  if (accounts.length === 0) throw new Error("No review manifests found.");
  const labels = accounts.map((a) => a.label);
  if (new Set(labels).size !== labels.length) throw new Error("Duplicate labels in the manifests.");
  const unmapped = labels.filter((l) => !LOGIN_BY_LABEL[l]);
  if (unmapped.length) throw new Error(`No simple login defined for: ${unmapped.join(",")}`);
  const targets = labels.map(emailForLabel);
  if (new Set(targets).size !== targets.length) throw new Error("Destination emails are not unique.");
  console.log(`Accounts in scope: ${accounts.length} (by immutable Auth id)`);

  // ---- pre-checks: existence, run identity, destination collisions (no write yet) ----
  const all = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    all.push(...data.users);
    if (data.users.length < 200) break;
  }
  const byId = new Map(all.map((u) => [u.id, u]));
  const ids = new Set(accounts.map((a) => a.authUserId));
  const problems = [];
  for (const a of accounts) {
    const u = byId.get(a.authUserId);
    if (!u) { problems.push(`${a.label}: Auth user not found`); continue; }
    if (!String(u.user_metadata?.vecta_staging_run_id ?? "").startsWith("dashboard-review-20261005")) problems.push(`${a.label}: not carrying the review run id`);
    const dest = emailForLabel(a.label);
    const owner = all.find((x) => (x.email ?? "").toLowerCase() === dest.toLowerCase());
    if (owner && owner.id !== a.authUserId) problems.push(`${a.label}: destination address is owned by another account`);
  }
  const legacyCount = all.filter((u) => !ids.has(u.id)).length;
  if (problems.length) { console.log(problems.join("\n")); throw new Error("Pre-checks failed; nothing was changed."); }
  console.log(`PRE-CHECKS ok: all ${accounts.length} exist and carry the run id; no destination collides; ${legacyCount} other accounts are out of scope and will not be touched`);
  if (dryRun) { console.log("DRY RUN: no change made."); return; }

  // ---- in-place update, per account ----
  const result = { updated: [], unchanged: [], failed: [] };
  const update = (label, patch) => { state.accounts[label] = { ...(state.accounts[label] ?? {}), ...patch }; writeJson(STATE_PATH, state); };
  for (const a of accounts) {
    const label = a.label;
    const dest = emailForLabel(label);
    try {
      if (state.accounts[label]?.done) { result.unchanged.push(label); continue; }
      const before = byId.get(a.authUserId);
      const prevEmail = a.previousEmail ?? before.email;
      // Auth: email + password in place (user id preserved; email_confirm so no mail is sent)
      const up = await client.auth.admin.updateUserById(a.authUserId, { email: dest, password, email_confirm: true });
      if (up.error) throw new Error(`auth update failed: ${up.error.message}`);
      if ((up.data.user.email ?? "").toLowerCase() !== dest.toLowerCase()) throw new Error("auth email did not change");
      update(label, { authUpdated: true, previousEmail: prevEmail, email: dest });
      // application email fields (supported update path: service-side table writes)
      const pr = await client.from("profiles").update({ email: dest }).eq("id", a.authUserId);
      if (pr.error) throw new Error(`profiles.email update failed: ${pr.error.message}`);
      if (a.kind === "caterlink_external") {
        const ur = await client.from("users").update({ email: dest }).eq("id", a.authUserId);
        if (ur.error) throw new Error(`users.email update failed: ${ur.error.message}`);
      }
      // sessions: supported admin endpoint where the project provides it
      let sessions = "unsupported";
      try {
        const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${a.authUserId}/sessions`, {
          method: "DELETE",
          headers: { apikey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        });
        sessions = r.ok ? "revoked" : `unsupported(${r.status})`;
      } catch { sessions = "unsupported"; }
      update(label, { done: true, sessions, doneAt: new Date().toISOString() });
      result.updated.push(label);
      console.log(`  UPDATED  ${label.padEnd(26)} -> ${dest}  [sessions: ${sessions}]`);
    } catch (e) {
      update(label, { error: String(e.message).slice(0, 200) });
      result.failed.push({ label, error: String(e.message).slice(0, 200) });
      console.log(`  FAILED   ${label} -- ${String(e.message).slice(0, 160)}`);
    }
  }

  // ---- private outputs (written for every account that is done) ----
  const done = accounts.filter((a) => state.accounts[a.label]?.done);
  const outCreds = { runIds: RUNS, updatedAt: new Date().toISOString(), note: "Shared staging review password applies to every account listed. Supersedes all earlier credential files.", accounts: [] };
  const outManifest = { supersedes: RUNS, projectRef: ctx.projectRef, updatedAt: new Date().toISOString(), accounts: [] };
  const mapping = [];
  for (const a of accounts) {
    const st = state.accounts[a.label] ?? {};
    const email = st.done ? emailForLabel(a.label) : (st.previousEmail ?? a.previousEmail ?? a.email);
    const prev = st.previousEmail ?? a.previousEmail ?? a.email;
    outManifest.accounts.push({ ...a, email, previousEmail: prev, renamed: Boolean(st.done) });
    if (st.done) outCreds.accounts.push({ label: a.label, display: a.display, roleCode: a.roleCode ?? a.accountRole, accountState: a.accountState ?? "approved", scope: a.scope ?? null, email, password, authUserId: a.authUserId, profileId: a.profileId, assignmentId: a.assignmentId ?? null, membershipId: a.membershipId ?? null });
    mapping.push({ label: a.label, authUserId: a.authUserId, oldEmail: prev, newEmail: st.done ? email : null, status: st.done ? "renamed" : "pending" });
  }
  writeJson(CRED_PATH, outCreds);
  writeJson(MANIFEST_PATH, outManifest);
  writeJson(MAPPING_PATH, mapping);

  // ---- supersede the old per-run credential/manifest files (only once everything is done) ----
  if (result.failed.length === 0) {
    for (const run of RUNS) {
      const dir = defaultCredentialsDir(run);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith("SUPERSEDED-")) continue;
        if (/^(credentials|manifest|verification)-/.test(f)) fs.renameSync(path.join(dir, f), path.join(dir, `SUPERSEDED-${f}`));
      }
      fs.writeFileSync(path.join(dir, "SUPERSEDED.txt"), `These per-run credential/manifest files are superseded by ${CURRENT_DIR} (logins renamed, shared password set). Do not use them.\n`, { mode: 0o600 });
    }
  }

  console.log(`\nUpdated: ${result.updated.length}  Unchanged (already done): ${result.unchanged.length}  Failed: ${result.failed.length}`);
  console.log(`Updated credentials (private): ${CRED_PATH}\nOld-to-new mapping (private): ${MAPPING_PATH}\nUpdated manifest (private): ${MANIFEST_PATH}`);
  void done;
  if (result.failed.length) process.exit(2);
}

main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 400)); process.exit(1); });
