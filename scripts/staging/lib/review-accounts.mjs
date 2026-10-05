// Loader for the CURRENT private review credentials / manifest (written by rename-reset-review-accounts.mjs).
// The older per-run files are renamed SUPERSEDED-* and must not be used. Nothing here prints a value.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CURRENT_REVIEW_DIR = path.join(os.tmpdir(), "vecta-staging-credentials", "vecta-review-current");

export function loadCurrentCredentials() {
  const p = path.join(CURRENT_REVIEW_DIR, "credentials.json");
  if (!fs.existsSync(p)) throw new Error("Current review credentials not found (run the rename/reset tool). Older per-run files are superseded.");
  return JSON.parse(fs.readFileSync(p, "utf8")).accounts;
}

export function loadCurrentManifest() {
  const p = path.join(CURRENT_REVIEW_DIR, "manifest.json");
  if (!fs.existsSync(p)) throw new Error("Current review manifest not found.");
  return JSON.parse(fs.readFileSync(p, "utf8")).accounts;
}

/** signInWithPassword with backoff when the Auth rate limit is hit (a rate-limit is not a credential failure). */
export async function signInWithRetry(sb, email, password, tries = 6) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    last = await sb.auth.signInWithPassword({ email, password });
    if (!last.error || !/rate limit/i.test(last.error.message ?? "")) return last;
    await new Promise((r) => setTimeout(r, 15000 * (i + 1)));
  }
  return last;
}
