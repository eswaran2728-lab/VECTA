// Phase "dashboard/role-workspaces-adjustment": shared safety boundary for
// every staging script in this directory. No script in scripts/staging/
// may construct a Supabase admin client without passing through here
// first -- this is the ONE place the production-reference guard and the
// explicit opt-in flag are enforced, so every tool shares the same gate
// rather than re-implementing (and potentially mis-implementing) it.

import { createClient } from "@supabase/supabase-js";

// Known/likely production project references for this codebase. This list
// is intentionally conservative -- it blocks the one reference we already
// know is live, and any reference the operator explicitly names as
// production via VECTA_PRODUCTION_PROJECT_REF. It is NOT a substitute for
// the operator's own confirmation step; it exists to catch an obvious
// mistake, not to replace judgement.
const KNOWN_NON_STAGING_REFS = new Set(
  [process.env.VECTA_PRODUCTION_PROJECT_REF?.trim()].filter(Boolean)
);

export function projectRefFromUrl(url) {
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? "");
  return match ? match[1] : null;
}

/**
 * Validates the environment and returns { client, projectRef, hostname }.
 * Throws with a clear, actionable message (never a secret) on any
 * violation. This function performs NO network call -- callers decide
 * when to actually touch the hosted project, after displaying the
 * identity this function resolves and obtaining explicit confirmation.
 */
export function resolveStagingAdminContext({ requireApprovedRef = true } = {}) {
  if (process.env.VECTA_ALLOW_STAGING_PROVISIONING !== "true") {
    throw new Error(
      "Refusing to run: VECTA_ALLOW_STAGING_PROVISIONING is not exactly 'true'. This is the explicit opt-in required before any staging script may even construct an admin client."
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error("Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not set.");
  }
  if (!serviceRoleKey) {
    throw new Error(
      "Refusing to run: SUPABASE_SERVICE_ROLE_KEY is not set. No staging script may proceed without it -- there is no fallback credential and none should ever be invented."
    );
  }

  const projectRef = projectRefFromUrl(url);
  if (!projectRef) {
    throw new Error(`Refusing to run: could not parse a project reference out of NEXT_PUBLIC_SUPABASE_URL (${url.replace(/^https?:\/\//, "").split(".")[0]}...).`);
  }

  if (KNOWN_NON_STAGING_REFS.has(projectRef)) {
    throw new Error(`Refusing to run: project reference "${projectRef}" is listed as a known production reference (VECTA_PRODUCTION_PROJECT_REF).`);
  }

  const approvedRef = process.env.VECTA_APPROVED_STAGING_PROJECT_REF?.trim();
  if (requireApprovedRef) {
    if (!approvedRef) {
      throw new Error(
        "Refusing to run: VECTA_APPROVED_STAGING_PROJECT_REF is not set. Set it to the EXACT project reference you have confirmed is the disposable staging/test project -- this script never guesses which project to touch."
      );
    }
    if (approvedRef !== projectRef) {
      throw new Error(
        `Refusing to run: the configured Supabase project reference ("${projectRef}") does not match VECTA_APPROVED_STAGING_PROJECT_REF ("${approvedRef}"). Fix the environment or the approved-ref value -- never override this check.`
      );
    }
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return { client, projectRef, hostname: `${projectRef}.supabase.co` };
}

/** Prints only non-secret identity information. Never pass a key/URL with
 * credentials in it to this function. */
export function printProjectIdentity({ projectRef, hostname }) {
  console.log(`Project reference: ${projectRef}`);
  console.log(`Hostname: ${hostname}`);
}
