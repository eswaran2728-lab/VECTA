// Reproduces the pending/rejected/deactivated-profile movement-visibility flaw and validates the PROPOSED (unapplied) repair in
// supabase/proposed-migrations/20261027000001_station_visibility_requires_approved_profile.sql.
//    node verify_profile_state_visibility.mjs        (native PostgreSQL only; needs `node migrate.mjs --native` first)
// SYNTHETIC FIXTURES: auth users, profiles, assignments, whitelist rows, one movement. Local disposable database only.
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (dir, n) => fs.readFileSync(path.join(__dirname, '..', '..', dir, n), 'utf8');
let failures = 0;
function assert(cond, msg) { if (!cond) { failures += 1; console.log('FAIL:', msg); return; } console.log('PASS:', msg); }

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_profile_state_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Profile-state visibility verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  const db = new Client({ ...pgConfig, database: runDb });
  await db.connect();
  await db.query('set check_function_bodies = off;');
  await db.query('begin;');
  await db.query(`
    create or replace function pg_temp.simulate_user(p_profile_id uuid) returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end; $$;
    create or replace function pg_temp.simulate_service_role() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', true); perform set_config('role', 'service_role', true); end; $$;
  `);
  const simulateUser = (id) => db.query('select pg_temp.simulate_user($1);', [id]);
  const simulateService = () => db.query('select pg_temp.simulate_service_role();');
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const asUser = async (id, fn) => { await simulateUser(id); try { return await fn(); } finally { await simulateService(); } };
  await simulateService();

  // staging-shaped users table
  await db.query('reset role;');
  await db.query('drop table public.users cascade;');
  for (const f of ['20261023000001_caterlink_external_account_table.sql', '20261024000001_canon_is_active_excludes_caterlink_only.sql']) await db.query(read('migrations', f));
  // golden rebuilt by migrate.mjs does not contain the proposal (it lives outside supabase/migrations); make sure of the defective state
  await db.query(`create or replace function public.has_station_assignment_for_transaction(p_aoc_id uuid, p_destination_station_id uuid, p_origin_station_id uuid) returns boolean language sql stable security definer set search_path to 'public' as $function$
    select exists (select 1 from public.user_role_assignments ura where ura.profile_id = auth.uid() and ura.aoc_id = p_aoc_id and (ura.station_id = p_destination_station_id or ura.station_id = p_origin_station_id) and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())); $function$;`);
  await simulateService();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const clDept = (await one("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAoc])).id;
  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));
  const KUL = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  const team = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };
  let seq = 0x1100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  async function person(label, status, { role = 'aso', station = KUL, timing = {} } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `ps-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `ps-${label}@example.test`, `PS ${label}`, `PS-${label}`.slice(0, 20), status]);
    const membership = ['operation_manager', 'caterlink_management'].includes(role) ? null : (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`,
      [id, roleMap.get(role), myAoc, role === 'caterlink_management' ? clDept : opsDept, station ? station.hub_id : null, station && ['aso', 'so', 'sso', 'dse'].includes(role) ? station.id : null, station ? await team(station) : null, membership, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  const approved = await person('approved', 'approved');
  const pending = await person('pending', 'pending');
  const rejected = await person('rejected', 'rejected');
  const deactivated = await person('deactivated', 'deactivated');
  const revoked = await person('revoked', 'approved', { timing: { revoked: new Date().toISOString() } });
  const expired = await person('expired', 'approved', { timing: { starts: new Date(Date.now() - 3 * 864e5).toISOString(), ends: new Date(Date.now() - 864e5).toISOString() } });
  const future = await person('future', 'approved', { timing: { starts: new Date(Date.now() + 864e5).toISOString() } });
  const mgmt = await person('mgmt', 'approved', { role: 'caterlink_management', station: null });
  const ops = await person('ops', 'approved', { role: 'operation_manager', station: null });
  const otherStation = await person('other', 'approved', { station: await one("select id, hub_id from public.org_stations where code = 'JHB';") });
  // the external Driver creates the movement
  const driver = nextId();
  await db.query('insert into auth.users (id, email) values ($1, $2);', [driver, 'ps-driver@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'ps-driver@example.test','PS Driver','PS-DRV','ASO','pending') on conflict (id) do update set status = 'pending';", [driver]);
  await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'PS Driver','PS-DRV','ps-driver@example.test','warehouse_pic','active');", [driver]);
  await db.query("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ('PS Caterer','PSC',$1,'active',true,current_date - 1);", [myAoc]);
  const co = (await one("select id from public.catering_companies where code = 'PSC';")).id;
  await db.query("insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ('PS9999A',$1,$2,'active',true,current_date - 1);", [co, myAoc]);
  await db.query("insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ('PS Driver Name','PSD001',$1,$2,'active',true,current_date - 1);", [co, myAoc]);
  await db.query('reset role;');
  await db.query(read('migrations', '20261025000001_caterlink_external_workflows.sql'));
  await simulateService();
  const tx = await asUser(driver, () => one("select * from public.create_caterlink_driver_transaction_secure('KUL - MAA','OUTBOUND','AIRCRAFT','PS9999A','PS Driver Name','PSD001','PS-SEAL','part-a/ps.png');"));

  const view = (id) => asUser(id, async () => ({
    t: (await db.query('select 1 from public.transactions where id = $1;', [tx.transaction_id])).rows.length === 1,
    a: (await db.query('select 1 from public.caterlink_checkpoint_part_a where transaction_id = $1;', [tx.transaction_id])).rows.length === 1,
    s: (await db.query('select 1 from public.seals where transaction_id = $1;', [tx.transaction_id])).rows.length === 1,
  }));
  const all = (v) => v.t && v.a && v.s;
  const none = (v) => !v.t && !v.a && !v.s;
  const who = { approved, pending, rejected, deactivated, revoked, expired, future, otherStation, mgmt, ops, driver };

  console.log('\n--- SECTION 1: the flaw reproduces on the current helper ---');
  {
    const v = {}; for (const [k, id] of Object.entries(who)) v[k] = await view(id);
    assert(all(v.approved), 'approved station officer reads the movement, Part A and seals (expected)');
    assert(all(v.pending) && all(v.rejected) && all(v.deactivated), 'FLAW: a pending, rejected and a deactivated profile with an active assignment read the movement, Part A and seals');
    assert(none(v.revoked) && none(v.expired) && none(v.future), 'revoked, expired and future-dated assignments are already denied');
    assert(none(v.otherStation), 'an officer at another station is denied');
    assert(all(v.mgmt) && all(v.ops) && all(v.driver), 'Management, Operation Manager and the creating Driver read it (other branches)');
  }

  console.log('\n--- SECTION 2: proposed repair ---');
  const before = await one("select pg_get_function_identity_arguments(p.oid) a, p.prosecdef d, p.provolatile v, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au from pg_proc p where p.proname = 'has_station_assignment_for_transaction';");
  const policyBefore = (await one("select md5(string_agg(policyname || coalesce(qual,''), ',' order by policyname)) h from pg_policies where tablename in ('transactions','seals','caterlink_checkpoint_part_a','part_b_c','caterlink_checkpoint_part_d','caterlink_checkpoint_hub','caterlink_checkpoint_redq');")).h;
  const scanBefore = (await one("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) h;")).h;
  await db.query('reset role;');
  await db.query(read('migrations', '20261027000001_station_visibility_requires_approved_profile.sql'));
  await simulateService();
  {
    const v = {}; for (const [k, id] of Object.entries(who)) v[k] = await view(id);
    assert(all(v.approved), 'an approved, active station officer still reads the movement, Part A and seals');
    assert(none(v.pending) && none(v.rejected) && none(v.deactivated), 'pending, rejected and deactivated profiles no longer read the movement or its seals/checkpoints');
    assert(none(v.revoked) && none(v.expired) && none(v.future) && none(v.otherStation), 'revoked, expired, future-dated and other-station remain denied');
    assert(all(v.mgmt) && all(v.ops) && all(v.driver), 'Management, Operation Manager and the creating Driver are unaffected');
    const after = await one("select pg_get_function_identity_arguments(p.oid) a, p.prosecdef d, p.provolatile v, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au from pg_proc p where p.proname = 'has_station_assignment_for_transaction';");
    assert(JSON.stringify(before) === JSON.stringify(after), 'signature, SECURITY DEFINER, volatility, pinned search_path and grants of the helper are unchanged');
    assert((await one("select md5(string_agg(policyname || coalesce(qual,''), ',' order by policyname)) h from pg_policies where tablename in ('transactions','seals','caterlink_checkpoint_part_a','part_b_c','caterlink_checkpoint_part_d','caterlink_checkpoint_hub','caterlink_checkpoint_redq');")).h === policyBefore, 'no policy was edited');
    assert((await one("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) h;")).h === scanBefore, 'the scan decision is untouched');
    assert((await one("select count(*)::int n from pg_policies where qual ilike '%has_station_assignment_for_transaction%' or with_check ilike '%has_station_assignment_for_transaction%';")).n === 1, 'the helper is used by exactly one policy (transactions_read_policy)');
  }
  console.log('\n--- SECTION 3: state changes take effect immediately and idempotently ---');
  {
    await db.query('reset role;');
    await db.query("set session_replication_role = replica;"); await db.query("update public.profiles set status = 'approved' where id = $1;", [pending]); await db.query("set session_replication_role = origin;");
    await simulateService();
    assert(all(await view(pending)), 'approving the pending profile restores its access (access follows the trusted profile state)');
    await db.query('reset role;');
    await db.query("set session_replication_role = replica;"); await db.query("update public.profiles set status = 'deactivated' where id = $1;", [approved]); await db.query("set session_replication_role = origin;");
    await simulateService();
    assert(none(await view(approved)), 'deactivating an approved officer removes access immediately');
    await db.query('reset role;');
    await db.query(read('migrations', '20261027000001_station_visibility_requires_approved_profile.sql'));
    await simulateService();
    assert(none(await view(approved)) && all(await view(pending)), 're-applying the repair is a no-op');
  }
  void otherStation;
  console.log(`\nProfile-state visibility verification completed. Total failures: ${failures}`);
  await db.query('rollback;');
  await db.end();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.end();
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
