#!/usr/bin/env node
// Refreshes the ONE staging test account whose assignment is meant to be FUTURE-dated (label neg-future-assignment, "future.assignment").
// That fixture was provisioned on 2026-10-05 with start = +1 day, so it silently became an ACTIVE assignment; this moves its start date
// ~10 years ahead again so the negative test means something.
//
//   node --env-file=.env.local scripts/staging/refresh-future-assignment-fixture.mjs                   # DRY RUN (default; rolls back)
//   node --env-file=.env.local scripts/staging/refresh-future-assignment-fixture.mjs --apply \
//        --authorization=REFRESH-FUTURE-ASSIGNMENT-FIXTURE   (+ VECTA_FIXTURE_REFRESH_AUTHORIZED=yes)  # LIVE: needs separate authorization
//
// Safety: staging-only (the approved project ref must match and the production ref must be absent from the environment); verified TLS;
// targets exactly one profile from the review manifest; changes exactly one column (starts_at) of exactly one non-revoked assignment row;
// everything else (profiles, auth users, every other assignment) is fingerprinted before and after and must be identical; idempotent;
// prints labels/booleans/counts only -- never a password, token, connection string or e-mail address.
import { environmentGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { planFixtureRefresh, resolveMode, selectFixtureAccount } from "./lib/future-fixture.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const fail = (m) => { throw new Error(m); };

async function main() {
  const mode = resolveMode({ apply: args.includes("--apply"), authorization: argVal("authorization"), envConfirmation: process.env.VECTA_FIXTURE_REFRESH_AUTHORIZED });
  environmentGates(); // approved staging ref only; the production ref must not appear anywhere in the environment
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("The production reference is present in the environment.");
  log(`mode: ${mode.toUpperCase()}${mode === "dry-run" ? " (nothing will be written)" : ""}`);

  const account = selectFixtureAccount(loadCurrentManifest());
  const { client } = await connectVerified();
  try {
    await client.query("begin");
    const prof = (await client.query("select id from public.profiles where lower(email) = lower($1)", [account.email])).rows;
    if (prof.length !== 1) fail(`The fixture profile resolved to ${prof.length} rows; refusing.`);
    const profileId = prof[0].id;

    const fingerprint = async () => (await client.query(
      `select
         (select md5(string_agg(md5(a::text), ',' order by a.id::text)) from public.user_role_assignments a where a.profile_id <> $1) as other_assignments,
         (select md5(string_agg(md5(p::text), ',' order by p.id::text)) from public.profiles p) as profiles,
         (select md5(string_agg(u.id::text || coalesce(u.encrypted_password, ''), ',' order by u.id::text)) from auth.users u) as auth_users`, [profileId])).rows[0];
    const before = await fingerprint();

    const rows = (await client.query(
      `select a.id, a.starts_at, a.ends_at, a.revoked_at, rd.code as role_code
         from public.user_role_assignments a join public.role_definitions rd on rd.id = a.role_definition_id where a.profile_id = $1`, [profileId])).rows;
    const plan = planFixtureRefresh(rows);
    log(`plan: ${plan.action} (${plan.reason})`);

    if (plan.action === "update") {
      const res = await client.query(
        "update public.user_role_assignments set starts_at = $2 where id = $1 and profile_id = $3 and revoked_at is null and ends_at is null returning id",
        [plan.id, plan.newStartsAt, profileId]);
      if (res.rowCount !== 1) fail(`Expected to update exactly one row, updated ${res.rowCount}.`);
      const after = await fingerprint();
      for (const k of Object.keys(before)) if (before[k] !== after[k]) fail(`Unexpected change in ${k}; rolling back.`);
      const check = (await client.query("select starts_at > now() + interval '300 days' as far from public.user_role_assignments where id = $1", [plan.id])).rows[0];
      if (!check.far) fail("The refreshed start date is not far enough ahead.");
      log("verified: one row changed (starts_at only); every other assignment, profile and auth user is byte-identical");
    }

    if (mode === "live" && plan.action === "update") {
      await client.query("commit");
      log("LIVE: committed.");
    } else {
      await client.query("rollback");
      log(mode === "live" ? "LIVE: nothing to change (already far in the future)." : "DRY RUN: rolled back; no data changed.");
    }
  } catch (e) {
    try { await client.query("rollback"); } catch { /* connection already closed */ }
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`FAILED: ${String(e.message ?? e).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`);
  process.exit(1);
});
