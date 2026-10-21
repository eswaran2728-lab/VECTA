#!/usr/bin/env node
// Resets the PASSWORD ONLY of the disposable staging review accounts (the 40 in the private review manifest, identified by immutable Auth user id and the
// review run id in their Auth metadata) to ONE newly generated strong shared password, then writes the private credential JSON (outside the repository,
// restrictive permissions), the confidential PDF and the plain-text copy. Profiles, assignments, memberships and account states are NOT touched, so the
// negative identities (pending, rejected, deactivated, revoked, expired, future-dated) stay negative. The password is never printed or logged.
//
//   node --env-file=.env.local scripts/staging/reset-review-passwords.mjs --expected-base=<sha> --url=<preview url> \
//        [--pdf=<path>] [--txt=<path>] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { gitGates, environmentGates, assertOutsideRepo, secureDirectory } from "./lib/run-gates.mjs";
import { CURRENT_REVIEW_DIR, signInWithRetry } from "./lib/review-accounts.mjs";
import { generateSharedPassword, renderCredentialText, renderCredentialHtml } from "./lib/credential-files.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const dryRun = args.includes("--dry-run");
const url = argVal("url");
const expectedBase = argVal("expected-base");
const pdfPath = argVal("pdf") ?? "C:\\Users\\eswaranp\\Desktop\\vecta-staging-all-role-logins-current.pdf";
const txtPath = argVal("txt") ?? "C:\\Users\\eswaranp\\Desktop\\vecta-staging-logins-copy.txt";
const REPO_PATH = path.resolve(import.meta.dirname, "../..");

async function main() {
  if (!url || !/^https:\/\/[a-z0-9.-]+\.vercel\.app\/?$/.test(url)) throw new Error("--url must be the https Preview URL");
  const git = gitGates({ expectedBase, expectedRepoPath: REPO_PATH, expectedBranch: "ui/stitch-mobile-redesign" });
  console.log(`GATE ok: HEAD ${git.head.slice(0, 12)}, clean tree, origin ${git.remote}`);
  environmentGates();
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  assertOutsideRepo(CURRENT_REVIEW_DIR, git.root);
  for (const p of [pdfPath, txtPath]) assertOutsideRepo(path.dirname(p), git.root);
  secureDirectory(CURRENT_REVIEW_DIR);
  const { client } = ctx;

  const manifest = JSON.parse(fs.readFileSync(path.join(CURRENT_REVIEW_DIR, "manifest.json"), "utf8")).accounts;
  const credPath = path.join(CURRENT_REVIEW_DIR, "credentials.json");
  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  if (manifest.length !== creds.accounts.length) throw new Error("manifest and credentials differ in size");

  const all = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    all.push(...data.users);
    if (data.users.length < 200) break;
  }
  const byId = new Map(all.map((u) => [u.id, u]));
  const problems = [];
  for (const a of manifest) {
    const u = byId.get(a.authUserId);
    if (!u) problems.push(`${a.label}: Auth user not found`);
    else if (!String(u.user_metadata?.vecta_staging_run_id ?? "").startsWith("dashboard-review-20261005")) problems.push(`${a.label}: not carrying the review run id`);
    else if (!/@vecta\.test$/i.test(u.email ?? "")) problems.push(`${a.label}: not on the staging test domain`);
  }
  if (problems.length) { console.log(problems.join("\n")); throw new Error("Pre-checks failed; nothing was changed."); }
  console.log(`PRE-CHECKS ok: ${manifest.length} review accounts exist, carry the run id and use the test domain; ${all.length - manifest.length} other accounts are out of scope and are not touched`);
  if (dryRun) { console.log("DRY RUN: no change made."); return; }

  const password = generateSharedPassword();
  const failed = [];
  for (const a of manifest) {
    const up = await client.auth.admin.updateUserById(a.authUserId, { password });
    if (up.error) { failed.push(a.label); continue; }
    try {
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${a.authUserId}/sessions`, {
        method: "DELETE",
        headers: { apikey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
    } catch { /* sessions endpoint is best effort */ }
  }
  if (failed.length) throw new Error(`password update failed for: ${failed.join(", ")} (no credential file was written)`);
  console.log(`PASSWORD updated for ${manifest.length} accounts (value not printed)`);

  // private credential JSON: the previous file is kept as SUPERSEDED (private directory only), the new one replaces it
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(credPath, path.join(CURRENT_REVIEW_DIR, `credentials.SUPERSEDED-${stamp}.json`));
  const next = { ...creds, updatedAt: new Date().toISOString(), note: "Shared staging review password applies to every account listed. Supersedes all earlier credential files.", accounts: creds.accounts.map((c) => ({ ...c, password })) };
  fs.writeFileSync(credPath, JSON.stringify(next, null, 2), { mode: 0o600 });

  // verification: every account authenticates with the new password; the superseded password no longer works
  const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let ok = 0; const bad = [];
  for (const c of next.accounts) {
    const sb = anon();
    const r = await signInWithRetry(sb, c.email, password);
    if (r.error || !r.data?.session) bad.push(c.label); else ok += 1;
    await sb.auth.signOut().catch(() => {});
  }
  const old = creds.accounts[0]?.password;
  let oldStillWorks = null;
  if (old && old !== password) { const r = await signInWithRetry(anon(), creds.accounts[0].email, old); oldStillWorks = Boolean(r.data?.session); }
  console.log(`AUTHENTICATED with the new password: ${ok}/${next.accounts.length}${bad.length ? ` (failed: ${bad.join(", ")})` : ""}; previous password still accepted: ${oldStillWorks}`);
  if (bad.length || oldStillWorks) throw new Error("credential verification failed");

  // confidential PDF + plain-text copy (outside the repository)
  const merged = next.accounts.map((c) => ({ ...c, kind: manifest.find((m) => m.label === c.label)?.kind, expectedWorkspace: manifest.find((m) => m.label === c.label)?.expectedWorkspace ?? c.expectedWorkspace }));
  const model = { url: url.replace(/\/$/, ""), password, accounts: merged };
  fs.writeFileSync(txtPath, renderCredentialText(model), { mode: 0o600 });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(renderCredentialHtml(model), { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "A4", landscape: true, printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" } });
  } finally { await browser.close(); }
  try { fs.chmodSync(pdfPath, 0o600); fs.chmodSync(txtPath, 0o600); } catch { /* best effort on Windows */ }
  console.log(`WROTE ${pdfPath} (${fs.statSync(pdfPath).size} bytes) and ${txtPath} (${fs.statSync(txtPath).size} bytes); private JSON updated in the credentials directory`);
}

main().catch((e) => { console.error(`FAILED: ${String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`); process.exit(1); });
