#!/usr/bin/env node
// Provisions the two CaterLink-only external review accounts (CaterLink Driver, Third-Party Vendor) in the approved
// staging project, using the EXISTING external-account model: a Supabase Auth user + one `public.users` account
// row (role `warehouse_pic` = Driver, `vendor` = Third-Party Vendor, status `active`). No role assignment, no
// entity membership and no VECTA profile approval is created -- these identities hold no VECTA authority.
//
// Same safety gates as provision-test-accounts.mjs (lib/run-gates.mjs): exact repo/branch/base, clean tree, approved
// staging only, verified TLS, authenticated backups, migration history, baseline counts. Passwords are generated per
// account, persisted immediately to the private credentials file outside the repository, and never printed.
// Idempotent: re-running reconciles and never rotates a password.
//
// Usage: node --env-file=.env.local scripts/staging/provision-caterlink-external-accounts.mjs --live \
//          --run-id=dashboard-review-20261005-caterlink --email-domain=example.invalid --expected-base=<sha> \
//          --expect-baseline='{"migrations":63,"finalMigration":"20261023000001","authUsers":54,"profiles":54,"orgTeams":18}' [--preflight-only]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import {
  gitGates, environmentGates, backupGates, connectVerified, baselineCounts, assertPreWriteBaseline,
  emailFor, defaultCredentialsDir, assertOutsideRepo, secureDirectory,
} from "./lib/run-gates.mjs";

export const CATERLINK_EXTERNAL_PLAN = [
  { label: "caterlink-driver", display: "CaterLink Driver", accountRole: "warehouse_pic", staffId: "UAT-CL-DRIVER", name: "UAT CaterLink Driver" },
  { label: "caterlink-vendor", display: "Third-Party Vendor", accountRole: "vendor", staffId: "UAT-CL-VENDOR", name: "UAT Third-Party Vendor" },
];

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const isLive = args.includes("--live");
const preflightOnly = args.includes("--preflight-only");
const runId = argVal("run-id");
const emailDomain = argVal("email-domain");
const expectedBase = argVal("expected-base");
const expectBaseline = argVal("expect-baseline");
const REPO_PATH = path.resolve(import.meta.dirname, "../..");
const randomStrongPassword = () => crypto.randomBytes(24).toString("base64url");
const readJson = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb);
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), { mode: 0o600 });

async function findAuthUserByEmail(client, email) {
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) return null;
  }
}

async function main() {
  if (!isLive) {
    console.log("DRY RUN (no network):");
    CATERLINK_EXTERNAL_PLAN.forEach((a, i) => console.log(`${i + 1} ${a.label} -> ${a.display} (users.role=${a.accountRole})`));
    return;
  }
  if (!runId || !emailDomain || !expectedBase) throw new Error("--run-id, --email-domain and --expected-base are required.");

  const git = gitGates({ expectedBase, expectedRepoPath: REPO_PATH, extraAllowed: [/^supabase\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/] });
  console.log(`GATE ok: repo/branch ok, HEAD ${git.head.slice(0, 12)} (base ${expectedBase.slice(0, 12)}), clean tree, origin ${git.remote}`);
  const envInfo = environmentGates();
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  if (ctx.projectRef !== envInfo.projectRef) throw new Error("Admin client project mismatch.");
  console.log("GATE ok: environment resolves only to the approved staging project; production reference absent");
  console.log(`GATE ok: ${backupGates(git.root).length} encrypted backups authenticate and live outside the repository`);
  const dir = defaultCredentialsDir(runId);
  assertOutsideRepo(dir, git.root);
  secureDirectory(dir);

  const { client: pg, explicitCa } = await connectVerified();
  try {
    console.log(`GATE ok: verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
    const pre = await baselineCounts(pg, runId);
    const firstRun = pre.runAuthUsers === 0;
    assertPreWriteBaseline(pre, { allowExistingRun: !firstRun, expected: expectBaseline ? JSON.parse(expectBaseline) : {} });
    if (!firstRun && (pre.runAuthUsers > CATERLINK_EXTERNAL_PLAN.length || pre.runAuthUsers !== pre.runMetadataUsers)) throw new Error("Existing run accounts are inconsistent; refusing.");
    const usersTable = (await pg.query("select to_regclass('public.users') is not null as ok")).rows[0].ok;
    if (!usersTable) throw new Error("public.users does not exist; apply migration 20261023000001 first.");
    console.log(`GATE ok: ${JSON.stringify(pre)}`);
  } finally { await pg.end(); }
  if (preflightOnly) { console.log("PREFLIGHT ONLY: nothing was written."); return; }

  const { client } = ctx;
  const credPath = path.join(dir, `credentials-${runId}.json`);
  const manifestPath = path.join(dir, `manifest-${runId}.json`);
  const credentials = readJson(credPath, { runId, accounts: [] });
  const manifest = readJson(manifestPath, { runId, projectRef: ctx.projectRef, accounts: [], runs: [] });
  const run = { at: new Date().toISOString(), created: { auth: 0, profiles: 0, accountRows: 0 }, reconciled: { auth: 0, profiles: 0, accountRows: 0 }, failed: [] };

  for (const a of CATERLINK_EXTERNAL_PLAN) {
    const email = emailFor(runId, a.label, emailDomain);
    try {
      let user = await findAuthUserByEmail(client, email);
      let authCreated = false;
      let password = null;
      if (!user) {
        password = randomStrongPassword();
        const { data, error } = await client.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { vecta_staging_run_id: runId, vecta_staging_label: a.label },
        });
        if (error) throw new Error(`createUser failed: ${error.message}`);
        user = data.user;
        authCreated = true;
        // Persist the password IMMEDIATELY (before any later step can fail).
        const rec = { label: a.label, email, password, authUserId: user.id };
        const idx = credentials.accounts.findIndex((c) => c.label === a.label);
        if (idx >= 0) credentials.accounts[idx] = { ...credentials.accounts[idx], ...rec }; else credentials.accounts.push(rec);
        writeJson(credPath, credentials);
      }

      // handle_new_user() already created the bare profile row; set identity text only. It stays unapproved: this
      // identity has no VECTA authority.
      const prof = await client.from("profiles").select("id").eq("id", user.id).maybeSingle();
      if (prof.error) throw new Error(`profile lookup failed: ${prof.error.message}`);
      if (prof.data) {
        const up = await client.from("profiles").update({ name: a.name, staff_no: a.staffId }).eq("id", user.id);
        if (up.error) throw new Error(`profile update failed: ${up.error.message}`);
      } else {
        throw new Error("The profile row created with the Auth user is missing.");
      }

      // the trusted external account row (existing model)
      const existing = await client.from("users").select("id, role, status").eq("id", user.id).maybeSingle();
      if (existing.error) throw new Error(`users lookup failed: ${existing.error.message}`);
      let rowCreated = false;
      if (!existing.data) {
        const ins = await client.from("users").insert({ id: user.id, name: a.name, staff_id: a.staffId, email, role: a.accountRole, status: "active" });
        if (ins.error) throw new Error(`users insert failed: ${ins.error.message}`);
        rowCreated = true;
      } else if (existing.data.role !== a.accountRole) {
        throw new Error("An account row exists with a different role; refusing to change it.");
      }

      const bump = (k, created) => { run[created ? "created" : "reconciled"][k] += 1; };
      bump("auth", authCreated); bump("profiles", authCreated); bump("accountRows", rowCreated);
      const record = { label: a.label, kind: "caterlink_external", display: a.display, accountRole: a.accountRole, email, authUserId: user.id, profileId: user.id, accountRowId: user.id, createdThisRun: { auth: authCreated, accountRow: rowCreated } };
      const mi = manifest.accounts.findIndex((m) => m.label === a.label);
      if (mi >= 0) manifest.accounts[mi] = { ...manifest.accounts[mi], ...record, createdThisRun: manifest.accounts[mi].createdThisRun ?? record.createdThisRun }; else manifest.accounts.push(record);
      const ci = credentials.accounts.findIndex((c) => c.label === a.label);
      const existingPw = ci >= 0 ? credentials.accounts[ci].password : null;
      const cred = { label: a.label, email, password: password ?? existingPw ?? "(not available: account pre-existed without a stored password; reset required)", display: a.display, accountRole: a.accountRole, expectedWorkspace: "/caterlink/dashboard (CaterLink only)", authUserId: user.id, profileId: user.id, accountRowId: user.id };
      if (ci >= 0) credentials.accounts[ci] = cred; else credentials.accounts.push(cred);
      writeJson(credPath, credentials);
      writeJson(manifestPath, manifest);
      console.log(`  ${authCreated ? "CREATED" : "RECONCILED"}  ${a.label.padEnd(18)} ${a.display}`);
    } catch (err) {
      run.failed.push({ label: a.label, error: String(err.message).slice(0, 300) });
      console.log(`  FAILED   ${a.label} -- ${String(err.message).slice(0, 200)}`);
      break;
    }
  }
  manifest.runs.push(run);
  writeJson(manifestPath, manifest);
  console.log(`\nCreated: ${JSON.stringify(run.created)}\nReconciled: ${JSON.stringify(run.reconciled)}\nFailed: ${run.failed.length}`);
  console.log(`Credentials file (passwords never displayed): ${credPath}`);
  console.log(`Run manifest: ${manifestPath}`);
  if (run.failed.length) process.exit(2);
}

main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 400)); process.exit(1); });
