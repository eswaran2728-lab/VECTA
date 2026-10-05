#!/usr/bin/env node
// Verifies the in-place rename + shared-password reset: every account signs in with its NEW login and the shared
// password under the SAME immutable Auth user id; the OLD login/password pairs (from the SUPERSEDED files) no longer
// authenticate; and the new login does not accept the old password. Publishable key only; prints labels and booleans.
// Usage: node --env-file=.env.local scripts/staging/verify-renamed-accounts.mjs
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, defaultCredentialsDir, connectVerified } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest, CURRENT_REVIEW_DIR, signInWithRetry } from "./lib/review-accounts.mjs";

const RUNS = ["dashboard-review-20261005", "dashboard-review-20261005-receipt", "dashboard-review-20261005-caterlink"];
let failures = 0;
const ok = (label, cond, note = "") => { if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

async function main() {
  environmentGates();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const fresh = () => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const creds = loadCurrentCredentials();
  const manifest = loadCurrentManifest();
  const mapping = JSON.parse(fs.readFileSync(path.join(CURRENT_REVIEW_DIR, "old-to-new-mapping.json"), "utf8"));

  // old credentials, kept only inside the SUPERSEDED files
  const old = new Map();
  for (const run of RUNS) {
    const f = path.join(defaultCredentialsDir(run), `SUPERSEDED-credentials-${run}.json`);
    if (!fs.existsSync(f)) continue;
    for (const a of JSON.parse(fs.readFileSync(f, "utf8")).accounts) old.set(a.label, a);
  }
  ok("All 40 accounts are mapped and renamed", mapping.length === 40 && mapping.every((m) => m.status === "renamed"));
  ok("Old per-run credential/manifest files are marked SUPERSEDED (none left under their original names)", RUNS.every((r) => {
    const d = defaultCredentialsDir(r);
    return fs.existsSync(path.join(d, "SUPERSEDED.txt")) && !fs.readdirSync(d).some((f) => /^(credentials|manifest|verification)-/.test(f));
  }));

  console.log("\n=== NEW LOGINS ===");
  for (const c of creds) {
    const sb = fresh();
    const { data, error } = await signInWithRetry(sb, c.email, c.password);
    const m = manifest.find((x) => x.label === c.label);
    ok(`${c.label.padEnd(26)} signs in as ${c.email} with the same Auth id`, !error && data?.user?.id === c.authUserId && data.user.id === m.authUserId, error ? error.message : "");
    await sb.auth.signOut().catch(() => {});
  }

  console.log("\n=== OLD CREDENTIALS NO LONGER AUTHENTICATE ===");
  let oldRefused = 0;
  for (const m of mapping) {
    const o = old.get(m.label);
    if (!o) { ok(`${m.label}: old credentials available for the check`, false); continue; }
    const sb = fresh();
    const a = await sb.auth.signInWithPassword({ email: m.oldEmail, password: o.password });
    const b = await sb.auth.signInWithPassword({ email: m.newEmail, password: o.password });
    const refused = Boolean(a.error) && Boolean(b.error);
    if (refused) oldRefused += 1;
    ok(`${m.label.padEnd(26)} old login+password refused; old password refused on the new login`, refused);
    await sb.auth.signOut().catch(() => {});
  }
  console.log(`\nOld credentials refused: ${oldRefused}/${mapping.length}`);

  console.log("\n=== PRESERVATION (database) ===");
  const { client: pg } = await connectVerified();
  try {
    await pg.query("BEGIN READ ONLY");
    const ids = manifest.map((m) => m.authUserId);
    const q = async (s, p) => (await pg.query(s, p)).rows;
    const users = await q("select id, email from auth.users where id = any($1::uuid[])", [ids]);
    ok("All 40 Auth user ids still exist and carry exactly the mapped new emails", users.length === 40 && users.every((u) => mapping.find((m) => m.authUserId === u.id)?.newEmail === u.email));
    const prof = await q("select id, email, status::text s from public.profiles where id = any($1::uuid[])", [ids]);
    ok("profiles.email matches the new login for every account", prof.length === 40 && prof.every((p) => mapping.find((m) => m.authUserId === p.id)?.newEmail === p.email));
    const states = new Map(prof.map((p) => [p.id, p.s]));
    const expectedNeg = { "pending.profile@vecta.test": "pending", "rejected.profile@vecta.test": "rejected", "deactivated.profile@vecta.test": "deactivated" };
    ok("Negative-state profile statuses are preserved (pending / rejected / deactivated)", Object.entries(expectedNeg).every(([e, s]) => states.get(mapping.find((m) => m.newEmail === e).authUserId) === s));
    const ext = await q("select email, role, status from public.users order by role");
    ok("public.users emails follow the rename; roles and active status preserved", ext.length === 2 && ext.every((r) => /^caterlink\.(driver|vendor)@vecta\.test$/.test(r.email) && r.status === "active") && ext.map((r) => r.role).sort().join() === "vendor,warehouse_pic");
    ok("38 assignments and 26 memberships preserved", (await q("select count(*)::int n from public.user_role_assignments where profile_id = any($1::uuid[])", [ids]))[0].n === 38 && (await q("select count(*)::int n from public.user_entity_memberships where profile_id = any($1::uuid[])", [ids]))[0].n === 26);
    ok("Auth users total 56; 16 unrelated legacy accounts keep their original emails (none renamed)", (await q("select count(*)::int n from auth.users"))[0].n === 56 && (await q("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' is null and email like '%@vecta.test'"))[0].n === 0);
    await pg.query("ROLLBACK");
  } finally { await pg.end(); }

  console.log(`\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
