import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Regression coverage for a real production defect found 2026-09-22:
 * every self-registered AVSEC/CaterLink account (via /register) ended up
 * with an EMPTY name/station/team/ops_group AND could never log in, even
 * after Management approval.
 *
 * Root cause (confirmed directly against the production database):
 *   1. public.handle_new_user() (a DB trigger on auth.users AFTER INSERT)
 *      inserts a bare (id, email) profiles row the instant auth.signUp()
 *      runs, before the app's own code adds the rest of the form data.
 *   2. app/api/auth/register/route.ts used the ordinary session-bound
 *      Supabase client (lib/supabase/server.ts createClient()) for both
 *      the duplicate-email check and the follow-up profile-detail write.
 *      Because Supabase Auth requires email confirmation on this project
 *      and this flow never sends/collects a confirmation link, auth.signUp()
 *      never established a session — so auth.uid() was null for the rest
 *      of the request, and every RLS policy on profiles (all of which key
 *      off auth.uid() or current_role_name()) silently excluded the row.
 *      The resulting error was only console.error'd, never returned to
 *      the client, so the API still reported "Registration submitted
 *      successfully."
 *   3. Because the email was never confirmed, the account could never
 *      sign in afterward, regardless of approval status.
 *
 * The fix (this file's subject) mirrors the ALREADY-PROVEN pattern used
 * by createStaffAccount() (lib/avsec/admin/actions.ts) for admin-created
 * accounts: use the service-role admin client
 * (admin.auth.admin.createUser({ email_confirm: true })) for an anonymous,
 * pre-auth registration request, since there is no session to rely on.
 *
 * This isn't practically testable end-to-end without a live Postgres/Auth
 * instance (this repo's test runner has neither), so this test instead
 * asserts the fixed source file's actual shape — it will fail loudly if
 * someone reverts to the plain session-bound client or drops
 * email_confirm: true, which is exactly the regression that must never
 * silently reappear.
 */
const routeSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "api", "auth", "register", "route.ts"),
  "utf8",
);

test("registration route uses the service-role admin client, not the session-bound client", () => {
  assert.match(routeSource, /createAdminClient/, "must import/use the admin client for this anonymous, pre-auth endpoint");
  assert.doesNotMatch(
    routeSource,
    /from "@\/lib\/supabase\/server"/,
    "must not use the session-bound client - auth.uid() is null for an anonymous registrant, so RLS silently drops every write",
  );
});

test("registration route pre-confirms the email so approval isn't permanently blocked by an unconfirmed account", () => {
  assert.match(routeSource, /email_confirm:\s*true/, "self-registered accounts are gated by admin approval, not an email link this flow never sends");
});

test("registration route surfaces a profile/user write failure instead of silently swallowing it", () => {
  assert.doesNotMatch(
    routeSource,
    /console\.error\("\[api\/auth\/register\][\s\S]{0,80}profileError\.message/,
    "a failed profile write must not be only logged - it must be returned to the caller as a real error",
  );
  assert.match(routeSource, /if \(profileError\) \{[\s\S]{0,350}status: 500/, "a failed profile write must return a 500 with the real error message");
});
