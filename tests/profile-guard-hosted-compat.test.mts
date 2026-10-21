import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const NEW_BODY = fs.readFileSync("supabase/migrations/20261118000005_profile_guard_hosted_compatible.sql", "utf8");
const CANONICAL_SRC = fs.readFileSync("supabase/migrations/20261102000002_entity_staff_maintenance.sql", "utf8");
const canonicalMatch = /create or replace function public\.enforce_profile_self_update\(\)[\s\S]*?\$function\$;/i.exec(CANONICAL_SRC);

const A = "00000000-0000-0000-0000-0000000000a1"; // approved staff
const P = "00000000-0000-0000-0000-0000000000a2"; // pending staff
const M = "00000000-0000-0000-0000-0000000000a3"; // MAA entity admin
const X = "00000000-0000-0000-0000-0000000000a4"; // AAX entity admin
const ENTITY_MAA = "00000000-0000-0000-0000-0000000000e1";

const LEGACY_COLUMNS = "unified_role text, ops_group text, org_id uuid, duty_post text,";

async function makeDb(withLegacy: boolean) {
  const db = new PGlite();
  await db.exec(`
    create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
    create table operating_entities (id uuid primary key, code text);
    insert into operating_entities values ('${ENTITY_MAA}', 'MAA'), ('00000000-0000-0000-0000-0000000000e2', 'AAX');
    create table profiles (
      id uuid primary key, email text, name text, staff_no text, station text, team text, role text, status text,
      ${withLegacy ? LEGACY_COLUMNS : ""}
      approval_state text, approved_by uuid, approved_at timestamptz, rejection_reason text,
      created_at timestamptz default now(), updated_at timestamptz default now()
    );
    create table user_registration_requests (profile_id uuid, requested_operating_entity_id uuid, status text, reviewer_id uuid);
    create table user_entity_memberships (profile_id uuid, operating_entity_id uuid);
    -- the entity-admin helper: MAA admin is M, AAX admin is X
    create function public.is_entity_admin(p_code text) returns boolean language sql stable as $$
      select (p_code = 'MAA' and auth.uid() = '${M}') or (p_code = 'AAX' and auth.uid() = '${X}') $$;
    insert into profiles (id, email, name, staff_no, station, team, role, status) values
      ('${A}', 'a@x.test', 'Approved', 'S1', 'KUL', 'ALPHA', 'ASO', 'approved'),
      ('${P}', 'p@x.test', 'Pending', 'S2', 'KUL', 'ALPHA', 'ASO', 'pending'),
      ('${M}', 'm@x.test', 'MAA Admin', 'S3', 'KUL', 'ALPHA', 'ASO', 'approved'),
      ('${X}', 'x@x.test', 'AAX Admin', 'S4', 'KUL', 'ALPHA', 'ASO', 'approved');
    insert into user_registration_requests values ('${P}', '${ENTITY_MAA}', 'pending', null);
  `);
  return db;
}
const as = async (db: PGlite, uid: string | null, role = "authenticated") => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false), set_config('request.jwt.claim.role', '${role}', false)`);
};
const attempt = async (db: PGlite, sql: string) => {
  await db.exec("begin");
  try { await db.exec(sql); return "ok"; } catch (e) { return String((e as Error).message); } finally { await db.exec("rollback"); }
};
const install = (db: PGlite, body: string) => db.exec(`${body}\ncreate trigger profiles_enforce_self_update before update on profiles for each row execute function public.enforce_profile_self_update();`);

test("failing first: the canonical body raises on a database without the retired columns, the repaired body does not", async () => {
  assert.ok(canonicalMatch, "canonical definition found in the repository history");
  const hosted = await makeDb(false);
  try {
    await install(hosted, canonicalMatch![0]);
    await as(hosted, A);
    const r = await attempt(hosted, "update profiles set name = 'New name' where id = '" + A + "'");
    assert.match(r, /unified_role|no field/i, "the canonical body fails on the hosted shape");
    await hosted.exec("drop trigger profiles_enforce_self_update on profiles");
    await install(hosted, NEW_BODY);
    assert.equal(await attempt(hosted, "update profiles set name = 'New name' where id = '" + A + "'"), "ok");
  } finally { await hosted.close(); }
});

for (const withLegacy of [false, true]) {
  test(`repaired guard keeps every rule (${withLegacy ? "canonical shape with retired columns" : "hosted shape without them"})`, async () => {
    const db = await makeDb(withLegacy);
    try {
      await install(db, NEW_BODY);
      await as(db, A);
      assert.equal(await attempt(db, `update profiles set name = 'Renamed' where id = '${A}'`), "ok", "an approved user may change their display name");
      for (const [label, set, rx] of [
        ["status", "status = 'approved_x'", /Not authorized to modify this field/],
        ["email", "email = 'new@x.test'", /Not authorized to modify this field/],
        ["approved_by", `approved_by = '${A}'`, /Not authorized to modify this field/],
        ["approved_at", "approved_at = now()", /Not authorized to modify this field/],
        ["rejection_reason", "rejection_reason = 'x'", /Not authorized to modify this field/],
        ["approval_state", "approval_state = 'active'", /Not authorized to modify this field/],
        ["station (reviewed)", "station = 'PEN'", /already been reviewed/],
        ["team (reviewed)", "team = 'BRAVO'", /already been reviewed/],
        ["role (reviewed)", "role = 'SO'", /already been reviewed/],
        ["staff_no (reviewed)", "staff_no = 'S9'", /already been reviewed/],
        ...(withLegacy ? [["unified_role", "unified_role = 'super_admin'", /Not authorized to modify this field/], ["org_id", "org_id = gen_random_uuid()", /Not authorized to modify this field/], ["duty_post", "duty_post = 'x'", /Not authorized to modify this field/], ["ops_group", "ops_group = 'x'", /Not authorized to modify this field/]] : []),
      ] as [string, string, RegExp][]) {
        assert.match(await attempt(db, `update profiles set ${set} where id = '${A}'`), rx, label);
      }
      // a pending user may complete the profile setup but never self-assign an admin role
      await as(db, P);
      assert.equal(await attempt(db, `update profiles set station = 'PEN', team = 'BRAVO', staff_no = 'S22' where id = '${P}'`), "ok");
      assert.match(await attempt(db, `update profiles set role = 'ADMIN' where id = '${P}'`), /Cannot self-assign this role/);
      assert.match(await attempt(db, `update profiles set role = 'SUPER_ADMIN' where id = '${P}'`), /Cannot self-assign this role/);
      assert.match(await attempt(db, `update profiles set status = 'approved' where id = '${P}'`), /Not authorized to modify this field/);
      // somebody else's profile
      await as(db, A);
      assert.match(await attempt(db, `update profiles set name = 'hijack' where id = '${P}'`), /Not authorized to modify this profile/);
      // the entity admin of the requested entity reviews the pending registration; the other entity's admin cannot
      await as(db, M);
      assert.equal(await attempt(db, `update profiles set status = 'approved', approved_by = '${M}', approved_at = now(), approval_state = 'active' where id = '${P}'`), "ok");
      await as(db, X);
      assert.match(await attempt(db, `update profiles set status = 'rejected', rejection_reason = 'no' where id = '${P}'`), /Not authorized to modify this profile/);
      assert.match(await attempt(db, `update profiles set name = 'x' where id = '${A}'`), /Not authorized to modify this profile/);
      // trusted backend writes bypass
      await as(db, null, "service_role");
      assert.equal(await attempt(db, `update profiles set status = 'deactivated', email = 'svc@x.test' where id = '${A}'`), "ok");
    } finally { await db.close(); }
  });
}

test("the repaired function keeps SECURITY DEFINER and a fixed search_path, and the migration changes nothing but this function body", async () => {
  const db = await makeDb(false);
  try {
    await install(db, NEW_BODY);
    const r = await db.query<{ sd: boolean; cfg: string }>("select prosecdef sd, coalesce(proconfig::text,'') cfg from pg_proc where proname = 'enforce_profile_self_update'");
    assert.equal(r.rows[0].sd, true);
    assert.match(r.rows[0].cfg, /search_path=public/);
  } finally { await db.close(); }
  const code = NEW_BODY.replace(/\$function\$[\s\S]*?\$function\$/, "").split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /\b(grant|revoke|create\s+policy|create\s+trigger|alter\s+table|drop\s|insert|delete|truncate)\b/i);
  assert.equal((NEW_BODY.match(/create or replace function/gi) ?? []).length, 1);
});
