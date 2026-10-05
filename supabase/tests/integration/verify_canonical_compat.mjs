// Merged operations model: canonical compatibility migration verification
// (20261020000001_canonical_operations_compatibility.sql).
//
// Proves, against the real migrated schema:
//  1. The legacy-RLS identity helpers (current_role_name/current_status/
//     current_station/current_team/submitter_role_rank) derive ONLY from
//     active canonical assignments and fail closed for revoked, expired,
//     future-dated, inactive-role, pending and rejected states.
//  2. A forged legacy profile value (role, station, team, ops_group) can
//     neither grant nor deny anything.
//  3. ops_group is irrelevant: identical canonical state gives identical
//     results whatever ops_group holds (including the retired IFC value).
//  4. Canonical absence-policy scoping, supervising-officer eligibility, the
//     ops_group-free compatibility functions, the SEC013 profiling policy.
//  5. Every public table keeps RLS; no FOR ALL policy remains; anon holds no
//     table or function privilege in public.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_canonical_compat.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_canonical_compat_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.log('FAIL:', msg);
    return;
  }
  console.log('PASS:', msg);
}

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '55433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_canonical_compat_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Canonical compatibility verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = {
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        await client.end();
        await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
        await admin.query(`drop database if exists ${runDb};`);
        await admin.end();
      },
    };
  } else {
    console.log('=== Canonical compatibility verification against PGlite embedded engine ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) {
      console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.');
      process.exit(1);
    }
    copyDir(GOLDEN_DATA_DIR, RUN_DATA_DIR);
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    db = {
      exec: (sql) => pgliteDb.exec(sql),
      query: (sql, params) => pgliteDb.query(sql, params),
      close: () => pgliteDb.close(),
    };
  }

  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');

  let seq = 0x500;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;

  await db.exec(`
    create or replace function pg_temp.simulate_user(p_profile_id uuid)
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end;
    $$;
    create or replace function pg_temp.simulate_service_role()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '{}', true);
      perform set_config('role', 'service_role', true);
    end;
    $$;
  `);
  const simulateUser = (id) => db.query('select pg_temp.simulate_user($1);', [id]);
  const simulateService = () => db.exec('select pg_temp.simulate_service_role();');

  let spSeq = 0;
  async function expectFail(fn) {
    const sp = `sp_${++spSeq}`;
    await db.exec(`savepoint ${sp};`);
    try {
      await fn();
      await db.exec(`release savepoint ${sp};`);
      return { failed: false, error: null };
    } catch (e) {
      await db.exec(`rollback to savepoint ${sp}; release savepoint ${sp};`);
      return { failed: true, error: e };
    }
  }

  await simulateService();

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const enfDept = (await one("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAoc])).id;
  const profilingUnit = (await one("select id from public.units where department_id = $1 and code = 'profiling';", [enfDept])).id;
  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));

  const station = async (code) => (await one("select s.id, s.hub_id from public.org_stations s where s.code = $1;", [code]));
  const kul = await station('KUL - MAA');
  const pen = await station('PEN');
  async function team(stationRow, name) {
    await db.query('insert into public.org_teams (station_id, name) values ($1, $2) on conflict (station_id, name) do nothing;', [stationRow.id, name]);
    return (await one('select id from public.org_teams where station_id = $1 and name = $2;', [stationRow.id, name])).id;
  }
  const kulAlpha = await team(kul, 'ALPHA');
  const kulBravo = await team(kul, 'BRAVO');
  const penAlpha = await team(pen, 'ALPHA');

  async function createUser(label, { legacyRole = 'ASO', status = 'approved', opsGroup = null, station = null, team = null } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `cc-${label}@example.test`]);
    await db.query(
      'insert into public.profiles (id, email, name, staff_no, role, status, ops_group, station, team) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role, status = excluded.status, ops_group = excluded.ops_group, station = excluded.station, team = excluded.team;',
      [id, `cc-${label}@example.test`, `CC ${label}`, `CC-${label}`.slice(0, 20), legacyRole, status, opsGroup, station, team],
    );
    return id;
  }
  async function membership(profileId) {
    const r = await one(
      "insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;",
      [profileId, myAoc, myEntity],
    );
    return r.id;
  }
  async function assign(profileId, code, scope = {}, timing = {}) {
    const needsMembership = ['aso', 'so', 'sso', 'dse', 'hub_se', 'profiling_so', 'profiling_aso'].includes(code);
    const membershipId = needsMembership ? await membership(profileId) : null;
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now() - interval '1 day'), $11, $12);`,
      [profileId, roleMap.get(code), scope.aoc ?? null, scope.dept ?? null, scope.unit ?? null, scope.hub ?? null, scope.station ?? null, scope.team ?? null, membershipId, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null],
    );
  }
  const stationScope = (st, tm) => ({ aoc: myAoc, dept: opsDept, hub: st.hub_id, station: st.id, team: tm });

  const helperView = async (id) => {
    await simulateUser(id);
    await db.exec("select set_config('role', 'service_role', true);"); // helpers are internal: not client-callable
    const r = await one('select public.current_role_name()::text as role, public.current_status()::text as status, public.current_station() as station, public.current_team() as team, public.is_monitor_or_above() as monitor;');
    await simulateService();
    return r;
  };

  console.log('\n--- SECTION 1: canonical helpers per role (compat mapping, scope, status) ---');
  const cases = [
    ['aso', 'aso', stationScope(kul, kulAlpha), 'ASO', 'KUL - MAA', 'ALPHA', false],
    ['so', 'so', stationScope(kul, kulAlpha), 'SO', 'KUL - MAA', 'ALPHA', true],
    ['sso', 'sso', stationScope(pen, penAlpha), 'SO', 'PEN', 'ALPHA', true],
    ['dse', 'dse', stationScope(kul, kulAlpha), 'DSE', 'KUL - MAA', 'ALPHA', true],
    ['hub_se', 'hub_se', { aoc: myAoc, dept: opsDept, hub: kul.hub_id }, 'DSE', null, null, true],
    ['operation_manager', 'operation_manager', { aoc: myAoc, dept: opsDept }, 'MANAGEMENT', null, null, true],
    ['main_enforcement', 'main_enforcement', { aoc: myAoc, dept: enfDept }, 'ENFORCEMENT', null, null, true],
    ['compliance', 'compliance', { aoc: myAoc, dept: (await one("select id from public.departments where aoc_id = $1 and code = 'compliance';", [myAoc])).id }, null, null, null, false],
    ['ghod', 'ghod', {}, null, null, null, false],
    ['profiling_aso', 'profiling_aso', { aoc: myAoc, dept: enfDept, unit: profilingUnit, hub: pen.hub_id, station: pen.id, team: penAlpha }, null, 'PEN', 'ALPHA', false],
  ];
  const ids = {};
  for (const [label, code, scope, compat, st, tm, monitor] of cases) {
    // legacy columns deliberately set to a DIFFERENT, higher rank + wrong station/team + the retired IFC group
    const id = await createUser(label, { legacyRole: 'MANAGEMENT', opsGroup: 'ifc_avsec', station: 'JHB', team: 'ZULU' });
    await assign(id, code, scope);
    ids[label] = id;
    const v = await helperView(id);
    assert(v.role === compat, `${code}: current_role_name() is ${compat ?? 'NULL (no invented legacy rank)'} regardless of a forged raw MANAGEMENT role`);
    assert(v.status === 'approved', `${code}: current_status() is approved for an active assignment`);
    assert(v.station === st && v.team === tm, `${code}: station/team come from the assignment (${st ?? 'none'}/${tm ?? 'none'}), not the forged profile text`);
    assert(v.monitor === monitor, `${code}: is_monitor_or_above() follows the canonical rank`);
  }

  console.log('\n--- SECTION 2: fail-closed assignment and profile states ---');
  const states = [
    ['revoked', { revoked: new Date(Date.now() - 3600_000).toISOString() }, 'approved'],
    ['expired', { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() }, 'approved'],
    ['future', { starts: new Date(Date.now() + 86400_000).toISOString() }, 'approved'],
    ['pendingprofile', {}, 'pending'],
    ['rejectedprofile', {}, 'rejected'],
  ];
  for (const [label, timing, status] of states) {
    const id = await createUser(`neg-${label}`, { legacyRole: 'MANAGEMENT', opsGroup: 'operation_avsec', station: 'KUL - MAA', team: 'ALPHA', status });
    await assign(id, 'aso', stationScope(kul, kulAlpha), timing);
    const v = await helperView(id);
    assert(v.role === null && v.status !== 'approved' && v.station === null && !v.monitor, `${label}: no role, not approved, no scope (fails closed)`);
  }
  {
    const id = await createUser('neg-inactiverole');
    await assign(id, 'aso', stationScope(kul, kulAlpha));
    await db.query("update public.role_definitions set is_active = false where code = 'aso';");
    const v = await helperView(id);
    await db.query("update public.role_definitions set is_active = true where code = 'aso';");
    assert(v.role === null && v.status !== 'approved', 'inactive role definition fails closed');
  }

  console.log('\n--- SECTION 3: forged legacy values never grant or deny (no assignment) ---');
  for (const raw of ['ADMIN', 'MANAGEMENT', 'ENFORCEMENT', 'DSE', 'SO', 'ASO']) {
    const id = await createUser(`forged-${raw}`, { legacyRole: raw, opsGroup: 'operation_avsec', station: 'KUL - MAA', team: 'ALPHA' });
    const v = await helperView(id);
    assert(v.role === null && v.status !== 'approved' && v.station === null && v.team === null && !v.monitor, `legacy-only ${raw} profile (approved, station/team/ops_group set) has no canonical identity`);
    await simulateUser(id);
    const zones = (await one('select count(*)::int as n from public.duty_zones;')).n;
    await simulateService();
    assert(zones === 0, `legacy-only ${raw} profile reads no legacy-gated reference rows`);
  }
  {
    const admin = await createUser('forged-admin-with-aso', { legacyRole: 'ADMIN' });
    await assign(admin, 'aso', stationScope(kul, kulAlpha));
    const v = await helperView(admin);
    assert(v.role === 'ASO' && !v.monitor, 'a raw ADMIN profile holding only an aso assignment is ASO, not ADMIN');
  }

  console.log('\n--- SECTION 4: ops_group is irrelevant (including the retired IFC value) ---');
  const variants = [];
  for (const og of [null, 'operation_avsec', 'ifc_avsec', 'hub_avsec']) {
    const id = await createUser(`og-${og ?? 'null'}`, { opsGroup: og });
    await assign(id, 'so', stationScope(kul, kulAlpha));
    variants.push(JSON.stringify(await helperView(id)));
  }
  assert(new Set(variants).size === 1, 'identical canonical state yields identical helper results for ops_group null / operation_avsec / ifc_avsec / hub_avsec');
  const defs = (await db.query(
    "select p.proname, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1);",
    [['needs_your_action_secure', 'apply_compatibility_profile_fields', 'current_role_name', 'current_status', 'current_station', 'current_team', 'submitter_role_rank', 'can_acknowledge_report', 'list_eligible_supervising_officers_secure']],
  )).rows;
  for (const f of defs) {
    const body = f.def.replace(/--[^\n]*/g, '');
    assert(!/ops_group\s*(=|<>|!=|in\b|is\b)/i.test(body.replace(/p_ops_group text/g, '')), `${f.proname} makes no ops_group comparison`);
  }
  assert(!defs.some((f) => /from profiles|public\.profiles p where p\.id = auth\.uid\(\) and p\.status = 'approved';\s*if v_role/i.test(f.def) && f.proname === 'needs_your_action_secure'), 'needs_your_action_secure no longer reads the legacy profile role');

  console.log('\n--- SECTION 5: compatibility functions without ops_group ---');
  {
    const profile = await createUser('compat-dse', { legacyRole: 'ASO' });
    const reg = await one("select id from public.org_stations where code = 'KUL - MAA';");
    const actor = ids.operation_manager;
    await db.query('select public.apply_compatibility_profile_fields($1, $2, $3, $4, $5, $6, $7);', [profile, 'dse', kul.hub_id, reg.id, kulAlpha, null, actor]);
    const p = await one('select role::text as role, station, team, ops_group from public.profiles where id = $1;', [profile]);
    assert(p.role === 'DSE' && p.station === 'KUL - MAA' && p.team === 'ALPHA', 'a KUL dse approval writes the compatibility rank/station/team WITHOUT any ops_group');
    assert(p.ops_group === null, 'ops_group is neither required nor written');
    const entity = await createUser('compat-ghod', { legacyRole: 'MANAGEMENT' });
    await db.query('select public.apply_compatibility_profile_fields($1, $2, $3, $4, $5, $6, $7);', [entity, 'ghod', null, null, null, null, actor]);
    const g = await one('select role::text as role, approval_state from public.profiles where id = $1;', [entity]);
    assert(g.role === 'MANAGEMENT' && g.approval_state === 'approved_pending_activation', 'roles without a legacy rank leave the legacy role untouched');
  }
  {
    await simulateUser(ids.so);
    const rows = (await db.query('select * from public.needs_your_action_secure();')).rows;
    await simulateService();
    assert(Array.isArray(rows), 'needs_your_action_secure runs for a canonical SO');
    await simulateUser(ids.hub_se);
    const none = (await db.query('select * from public.needs_your_action_secure();')).rows;
    await simulateService();
    assert(none.length === 0, 'a hub-wide DSE-rank account (no station/team) gets no station queue');
  }

  console.log('\n--- SECTION 6: absence_notices policies are canonical and scoped ---');
  {
    const submitter = await createUser('absence-submitter');
    for (const st of ['KUL - MAA', 'PEN']) {
      await db.query(
        "insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, remarks) values ($1, 'x', 'ASO', $2, 'ALPHA', current_date, now(), 'r');",
        [submitter, st],
      );
    }
    const count = async (id) => {
      await simulateUser(id);
      const n = (await one('select count(*)::int as n from public.absence_notices;')).n;
      await simulateService();
      return n;
    };
    assert((await count(ids.dse)) === 1, 'canonical KUL DSE sees only KUL absence notices');
    assert((await count(ids.operation_manager)) === 2, 'canonical operation_manager (MANAGEMENT rank) sees all');
    assert((await count(ids.main_enforcement)) === 2, 'canonical main_enforcement (ENFORCEMENT rank) sees all');
    assert((await count(ids.aso)) === 0, 'an ASO sees no one else\'s notices');
    assert((await count(ids.hub_se)) === 0, 'hub-wide account gets no legacy all-station visibility (uses the canonical Phase 8 reviewer RPC)');
    const forgedMgmt = await createUser('absence-forged-mgmt', { legacyRole: 'MANAGEMENT' });
    assert((await count(forgedMgmt)) === 0, 'a legacy-only MANAGEMENT profile sees nothing');
  }

  console.log('\n--- SECTION 7: supervising-officer eligibility is canonical ---');
  {
    const asoId = await createUser('so-asker', { legacyRole: 'ASO' });
    await assign(asoId, 'aso', stationScope(kul, kulAlpha));
    const soSame = await createUser('so-same', { legacyRole: 'ASO' });
    await assign(soSame, 'so', stationScope(kul, kulAlpha));
    const dseSame = await createUser('dse-same', { legacyRole: 'ASO' });
    await assign(dseSame, 'dse', stationScope(kul, kulAlpha));
    const soOtherTeam = await createUser('so-bravo');
    await assign(soOtherTeam, 'so', stationScope(kul, kulBravo));
    const soOtherStation = await createUser('so-pen');
    await assign(soOtherStation, 'so', stationScope(pen, penAlpha));
    const soRevoked = await createUser('so-revoked');
    await assign(soRevoked, 'so', stationScope(kul, kulAlpha), { revoked: new Date(Date.now() - 3600_000).toISOString() });
    const forgedSo = await createUser('so-forged', { legacyRole: 'SO', station: 'KUL - MAA', team: 'ALPHA', opsGroup: 'ifc_avsec' });
    const asoOnly = await createUser('so-wrongrole', { legacyRole: 'SO' });
    await assign(asoOnly, 'aso', stationScope(kul, kulAlpha));

    await simulateUser(asoId);
    const listed = (await db.query('select id from public.list_eligible_supervising_officers_secure();')).rows.map((r) => r.id).sort();
    const okSame = (await one('select public.is_eligible_supervising_officer_secure($1) as ok;', [soSame])).ok;
    const okForged = (await one('select public.is_eligible_supervising_officer_secure($1) as ok;', [forgedSo])).ok;
    await simulateService();
    assert(listed.includes(soSame) && listed.includes(dseSame), 'the canonical so and dse on the SAME station and team are eligible');
    assert(!listed.includes(asoId), 'the asker is never listed');
    const listedRoles = (await db.query("select distinct rd.code from public.user_role_assignments ura join public.role_definitions rd on rd.id = ura.role_definition_id where ura.profile_id = any($1::uuid[])", [listed])).rows.map((r) => r.code).sort();
    assert(listedRoles.every((c) => ['dse', 'so', 'sso'].includes(c)), 'every listed officer holds a canonical so/sso/dse role');
    assert(okSame === true && okForged === false, 'a forged legacy SO profile is not eligible');
    assert(!listed.includes(soOtherTeam) && !listed.includes(soOtherStation) && !listed.includes(soRevoked) && !listed.includes(asoOnly), 'other team, other station, revoked assignment and a legacy-SO/canonical-ASO are all excluded');
    await simulateUser(forgedSo);
    const forgedList = (await db.query('select id from public.list_eligible_supervising_officers_secure();')).rows;
    await simulateService();
    assert(forgedList.length === 0, 'a legacy-only caller gets an empty officer list');
    await db.exec('set role anon;');
    const anonDenied = await expectFail(() => db.query('select * from public.list_eligible_supervising_officers_secure();'));
    await simulateService();
    assert(anonDenied.failed, 'anon cannot call the eligibility RPC');
  }

  console.log('\n--- SECTION 8: SEC013 canonical policy; RLS and grants posture ---');
  {
    const pol = (await db.query("select qual, with_check from pg_policies where schemaname='public' and tablename='report_sec013' and policyname='sec013_profiling_canonical_insert';")).rows;
    assert(pol.length === 1 && /has_active_role/.test(pol[0].with_check) && /profiling_so/.test(pol[0].with_check), 'Staff Profiling files SEC013 through a canonical has_active_role policy');
  }
  {
    const noRls = (await db.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;")).rows;
    assert(noRls.length === 0, `every public table has RLS enabled${noRls.length ? ' (missing: ' + noRls.map((r) => r.relname).join(',') + ')' : ''}`);
    const allPolicies = (await db.query("select tablename, policyname from pg_policies where schemaname='public' and cmd='ALL';")).rows;
    assert(allPolicies.length === 0, `no FOR ALL policy remains in public${allPolicies.length ? ' (' + allPolicies.map((p) => p.policyname).join(', ') + ')' : ''}`);
    const zones = (await db.query("select cmd from pg_policies where schemaname='public' and tablename='duty_zones' order by cmd;")).rows.map((r) => r.cmd);
    assert(zones.join() === 'DELETE,INSERT,SELECT,UPDATE', 'duty_zones has one canonical operation-specific policy per operation (no FOR ALL, no legacy ADMIN policy)');
    const anonTables = (await db.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger');")).rows;
    assert(anonTables.length === 0, `anon holds no privilege on any public table${anonTables.length ? ' (' + anonTables.map((r) => r.relname).join(',') + ')' : ''}`);
    const anonFns = (await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype='e');")).rows;
    assert(anonFns.length === 0, `anon can execute no public function${anonFns.length ? ' (' + anonFns.map((r) => r.proname).join(',') + ')' : ''}`);
    await db.exec('set role anon;');
    const anonRead = await expectFail(() => db.query('select count(*) from public.profiles;'));
    await simulateService();
    assert(anonRead.failed, 'an anonymous client cannot read profiles');
    await simulateUser(ids.aso);
    const auth = await one("select public.get_my_active_role_assignments() is not null as ok;").catch(() => ({ ok: true }));
    const rpcRows = (await db.query('select * from public.get_my_active_role_assignments();')).rows;
    await simulateService();
    assert(rpcRows.length === 1 && rpcRows[0].role_code === 'aso', 'authenticated keeps working access to its own canonical assignment RPC');
    void auth;
    const helperPrivs = (await db.query("select has_function_privilege('authenticated', 'public.canonical_compat_role_for(uuid)', 'execute') as auth_exec, has_function_privilege('anon', 'public.canonical_compat_role_for(uuid)', 'execute') as anon_exec;")).rows[0];
    assert(helperPrivs.auth_exec === false && helperPrivs.anon_exec === false, "the per-profile compat helper is not callable by clients (no probing of another user's rank)");
  }

  console.log('\n--- SECTION 8b: canonical roster authority, officer/team reads, SEC014 acknowledgement ---');
  {
    const asUser = async (id, sql, params) => {
      await simulateUser(id);
      try { return (await db.query(sql, params)).rows; } finally { await simulateService(); }
    };
    const can = async (id, st, tm) => (await asUser(id, 'select public.can_manage_roster_secure($1, $2) as ok;', [st, tm]))[0].ok;
    assert((await can(ids.operation_manager, 'KUL - MAA', 'ALPHA')) === true && (await can(ids.operation_manager, 'PEN', 'ALPHA')) === true, 'operation_manager manages rosters at every station');
    assert((await can(ids.dse, 'KUL - MAA', 'ALPHA')) === true, 'dse manages the roster of its own station and team');
    assert((await can(ids.dse, 'KUL - MAA', 'BRAVO')) === false, 'dse cannot manage another team at its station');
    assert((await can(ids.dse, 'PEN', 'ALPHA')) === false, 'dse cannot manage another station');
    assert((await can(ids.hub_se, 'KUL - MAA', 'ALPHA')) === true, 'hub_se manages rosters for stations of its assigned hub (matches the page gate and links)');
    for (const label of ['aso', 'so', 'sso', 'main_enforcement', 'compliance', 'ghod', 'profiling_aso']) {
      assert((await can(ids[label], 'KUL - MAA', 'ALPHA')) === false, `${label} has no roster-write authority`);
    }
    // forged legacy DSE / ops_group with no assignment
    const forged = await createUser('roster-forged-dse', { legacyRole: 'DSE', opsGroup: 'operation_avsec', station: 'KUL - MAA', team: 'ALPHA' });
    assert((await can(forged, 'KUL - MAA', 'ALPHA')) === false, 'a forged legacy DSE profile (station/team/ops_group set) cannot manage the roster');
    // revoked dse
    const revoked = await createUser('roster-revoked-dse');
    await assign(revoked, 'dse', stationScope(kul, kulAlpha), { revoked: new Date(Date.now() - 3600_000).toISOString() });
    assert((await can(revoked, 'KUL - MAA', 'ALPHA')) === false, 'a revoked dse assignment fails closed');
    // anonymous
    await simulateService();
    // officer / team reads follow the same authority
    const officersOm = await asUser(ids.operation_manager, "select * from public.list_roster_officers_secure('KUL - MAA');");
    const officersSo = await asUser(ids.so, "select * from public.list_roster_officers_secure('KUL - MAA');");
    assert(officersOm.some((o) => o.id === ids.so) && officersSo.length === 0, 'officer list: operation_manager sees station officers; an so sees none');
    const officersDse = await asUser(ids.dse, "select * from public.list_roster_officers_secure('KUL - MAA');");
    assert(officersDse.every((o) => o.team === 'ALPHA'), 'officer list for a dse is confined to its own team');
    const teamsDse = await asUser(ids.dse, "select * from public.list_roster_teams_secure('KUL - MAA');");
    assert(teamsDse.length === 1 && teamsDse[0].team === 'ALPHA', 'team list for a dse is confined to its own team');
    const teamsHub = await asUser(ids.hub_se, "select * from public.list_roster_teams_secure('KUL - MAA');");
    assert(teamsHub.length >= 2, 'team list for hub_se covers every team of the station');
    // write path
    const r1 = await expectFail(() => asUser(ids.so, "select public.clear_roster_cell_secure('KUL - MAA','ALPHA', current_date);"));
    assert(r1.failed, 'clear_roster_cell_secure refuses an so');
    const r2 = await expectFail(() => asUser(ids.dse, "select public.clear_roster_cell_secure('KUL - MAA','BRAVO', current_date);"));
    assert(r2.failed, 'clear_roster_cell_secure refuses a dse for another team');
    const r3 = await expectFail(() => asUser(ids.dse, "select public.clear_roster_cell_secure('KUL - MAA','ALPHA', current_date);"));
    assert(!r3.failed, 'clear_roster_cell_secure allows a dse for its own team');
    // anon has no execute
    const priv = (await db.query("select has_function_privilege('anon','public.can_manage_roster_secure(text,text)','execute') as a, has_function_privilege('authenticated','public.can_manage_roster_secure(text,text)','execute') as b;")).rows[0];
    assert(priv.a === false && priv.b === true, 'roster RPCs: anon denied, authenticated granted');

    // SEC014 acknowledgement special case is canonical (SO or DSE of the ASO's own station/team)
    const ackDef = (await one("select pg_get_functiondef('public.can_acknowledge_report(text,uuid)'::regprocedure) as d;")).d;
    assert(/p_report_type = 'sec014'/.test(ackDef) && /'so', 'sso', 'dse'/.test(ackDef) && /canon_/.test(ackDef), 'can_acknowledge_report keeps the SEC014 SO/SSO/DSE rule on canonical levels');
    assert(!/ops_group/.test(ackDef.replace(/--[^\n]*/g, '')), 'can_acknowledge_report does not reference ops_group');
    await simulateUser(ids.so);
    const none = (await db.query("select public.can_acknowledge_report('sec014', gen_random_uuid()) as ok;")).rows[0].ok;
    await simulateService();
    assert(none === false, 'acknowledging a non-existent report is denied');
  }

  console.log('\n--- SECTION 8c: profile guard allows only authorised canonical registration review ---');
  {
    const admin = await createUser('guard-entity-admin', { legacyRole: 'ASO' });
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at)
       values ($1, $2, $3, $4, now() - interval '1 day');`,
      [admin, roleMap.get('maa_admin'), myAoc, myEntity],
    );
    const victim = await createUser('guard-victim', { legacyRole: 'ASO', status: 'approved' });
    const tryUpdate = async (actor) => {
      await simulateUser(actor);
      let changed = 0;
      try {
        changed = (await expectFail(async () => {
          const r = await db.query("update public.profiles set status = 'rejected' where id = $1 returning id;", [victim]);
          if (r.rows.length === 0) throw new Error('no rows');
        })).failed ? 0 : 1;
      } finally {
        await simulateService();
      }
      const st = (await one('select status::text as s from public.profiles where id = $1;', [victim])).s;
      return { changed, st };
    };
    const a1 = await tryUpdate(admin);
    assert(a1.changed === 0 && a1.st === 'approved', 'a canonical entity admin cannot modify a profile that has no registration request in their entity');
    const forgedAdmin = await createUser('guard-forged-admin', { legacyRole: 'ADMIN' });
    const a2 = await tryUpdate(forgedAdmin);
    assert(a2.changed === 0 && a2.st === 'approved', 'a forged legacy ADMIN profile (no assignment) cannot modify another profile');
  }

  console.log('\n--- SECTION 8d: narrowed policies, grants, scope, states, anon, forged ranks ---');
  {
    // (a) no policy and no authorization function depends on the compatibility rank
    const compatNames = ['current_role_name', 'current_role_rank', 'is_monitor_or_above', 'is_approved_management', 'submitter_role_rank', 'canonical_compat_role_for'];
    const polRefs = (await db.query(
      "select tablename, policyname from pg_policies where schemaname='public' and exists (select 1 from unnest($1::text[]) h where position(h in coalesce(qual,'') || coalesce(with_check,'')) > 0);",
      [compatNames],
    )).rows;
    assert(polRefs.length === 0, `no RLS policy references the compatibility rank or a legacy role${polRefs.length ? ' (' + polRefs.map((r) => r.tablename + '.' + r.policyname).join(', ') + ')' : ''}`);
    const fnRefs = (await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') and not (p.proname = any($1)) and p.proname <> 'apply_compatibility_profile_fields' and exists (select 1 from unnest($1::text[]) h where position(h in p.prosrc) > 0);",
      [compatNames],
    )).rows;
    assert(fnRefs.length === 0, `no function authorizes from the compatibility rank${fnRefs.length ? ' (' + fnRefs.map((r) => r.proname).join(', ') + ')' : ''}`);
    const profRoleRefs = (await db.query("select tablename, policyname from pg_policies where schemaname='public' and (coalesce(qual,'') || coalesce(with_check,'')) ~ '(profiles|p)[.](role|ops_group|unified_role)';")).rows;
    assert(profRoleRefs.length === 0, 'no policy reads profiles.role / unified_role / ops_group');

    // (b) no blanket policies
    const blanket = (await db.query("select tablename, policyname from pg_policies where schemaname='public' and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');")).rows;
    assert(blanket.length === 0, `no using(true)/with check(true) policy remains${blanket.length ? ' (' + blanket.map((r) => r.tablename + '.' + r.policyname).join(', ') + ')' : ''}`);
    const updNoCheck = (await db.query("select tablename, policyname from pg_policies where schemaname='public' and cmd='UPDATE' and (qual is null or with_check is null);")).rows;
    assert(updNoCheck.length === 0, `every UPDATE policy has both USING and WITH CHECK${updNoCheck.length ? ' (' + updNoCheck.map((r) => r.tablename + '.' + r.policyname).join(', ') + ')' : ''}`);
    const publicRole = (await db.query("select tablename, policyname from pg_policies where schemaname='public' and 'public' = any(roles);")).rows;
    assert(publicRole.length === 0, `no policy is granted to PUBLIC${publicRole.length ? ' (' + publicRole.map((r) => r.tablename + '.' + r.policyname).join(', ') + ')' : ''}`);

    // (c) sensitive columns are not selectable
    const colPriv = (await db.query("select has_column_privilege('authenticated','public.drivers','staff_ic_number','select') as ic, has_column_privilege('authenticated','public.drivers','airport_pass_number','select') as pass, has_column_privilege('authenticated','public.drivers','name','select') as nm, has_column_privilege('authenticated','public.vehicles','approved_by','select') as va;")).rows[0];
    assert(colPriv.ic === false && colPriv.pass === false && colPriv.va === false && colPriv.nm === true, 'drivers/vehicles: IC numbers, pass numbers and audit fields are not selectable; minimal columns are');

    // (d) reference reads need approved profile + active assignment; states fail closed
    const refAso = await createUser('ref-aso');
    await assign(refAso, 'aso', stationScope(kul, kulAlpha));
    const refNone = await createUser('ref-unassigned');
    const refPending = await createUser('ref-pending', { status: 'pending' });
    await assign(refPending, 'aso', stationScope(kul, kulAlpha));
    const refForged = await createUser('ref-forged-mgmt', { legacyRole: 'MANAGEMENT', opsGroup: 'operation_avsec', station: 'KUL - MAA', team: 'ALPHA' });
    const stateUsers = {};
    for (const [label, timing] of [['revoked', { revoked: new Date(Date.now() - 3600_000).toISOString() }], ['expired', { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() }], ['future', { starts: new Date(Date.now() + 86400_000).toISOString() }]]) {
      const id = await createUser(`ref-${label}`);
      await assign(id, 'aso', stationScope(kul, kulAlpha), timing);
      stateUsers[label] = id;
    }
    const rejected = await createUser('ref-rejected', { status: 'rejected' });
    await assign(rejected, 'aso', stationScope(kul, kulAlpha));
    const inactiveRole = await createUser('ref-inactive-role');
    await assign(inactiveRole, 'aso', stationScope(kul, kulAlpha));
    await db.query("update public.role_definitions set is_active = false where code = 'aso';");
    const inactiveCanon = await (async () => { await simulateUser(inactiveRole); try { return (await one('select public.canon_is_active() as ok;')).ok; } finally { await simulateService(); } })();
    await db.query("update public.role_definitions set is_active = true where code = 'aso';");
    assert(inactiveCanon === false, 'an inactive role definition fails closed for canonical reference reads');
    const readCount = async (id, table) => { await simulateUser(id); try { return (await one(`select count(*)::int as n from public.${table};`)).n; } finally { await simulateService(); } };
    for (const table of ['stations', 'teams', 'shifts', 'aircraft_types', 'station_teams']) {
      const base = (await one(`select count(*)::int as n from public.${table};`)).n;
      if (base === 0) continue;
      assert((await readCount(refAso, table)) === base, `${table}: an approved, actively assigned user reads the reference rows`);
      for (const [label, id] of [['unassigned', refNone], ['pending profile', refPending], ['forged MANAGEMENT/ops_group legacy profile', refForged], ['revoked', stateUsers.revoked], ['expired', stateUsers.expired], ['future', stateUsers.future], ['rejected', rejected]]) {
        assert((await readCount(id, table)) === 0, `${table}: ${label} reads nothing`);
      }
    }
    await db.exec('set role anon;');
    const anonRef = await expectFail(() => db.query('select count(*) from public.stations;'));
    await simulateService();
    assert(anonRef.failed, 'anon cannot read reference tables');

    // (e) scope: station / team / hub visibility
    const kulDse = await createUser('scope-dse-kul'); await assign(kulDse, 'dse', stationScope(kul, kulAlpha));
    const penDse = await createUser('scope-so-pen'); await assign(penDse, 'so', stationScope(pen, penAlpha));
    const hubUser = await createUser('scope-hub'); await assign(hubUser, 'hub_se', { aoc: myAoc, dept: opsDept, hub: kul.hub_id });
    const opMgr = await createUser('scope-opmgr'); await assign(opMgr, 'operation_manager', { aoc: myAoc, dept: opsDept });
    const probe = async (id, sql, params) => { await simulateUser(id); try { return (await one(sql, params)).ok; } finally { await simulateService(); } };
    const vis = (id, st, tm) => probe(id, 'select public.canon_team_visible($1,$2) as ok;', [st, tm]);
    const sv = (id, st) => probe(id, 'select public.canon_station_visible($1) as ok;', [st]);
    assert((await sv(kulDse, 'KUL - MAA')) === true && (await sv(kulDse, 'PEN')) === false, 'cross-station: a KUL dse sees KUL but not PEN');
    assert((await vis(kulDse, 'KUL - MAA', 'ALPHA')) === true && (await vis(kulDse, 'KUL - MAA', 'BRAVO')) === false, 'cross-team: a dse sees its own team only');
    assert((await sv(hubUser, 'KUL - MAA')) === true, 'a hub_se sees stations of its own hub (hub-wide oversight)');
    const otherHub = await one('select s.code from public.org_stations s where s.hub_id is distinct from $1 limit 1;', [kul.hub_id]);
    if (otherHub) assert((await sv(hubUser, otherHub.code)) === false, 'cross-hub: a hub_se cannot see a station of another hub');
    assert((await sv(opMgr, 'PEN')) === true, 'operation_manager sees every station through its CANONICAL role code');
    assert((await sv(refForged, 'KUL - MAA')) === false && (await sv(refNone, 'KUL - MAA')) === false, 'forged MANAGEMENT/ops_group profile and unassigned users see no station');

    // operation_manager held only in another AOC must not reach MY legacy data
    const zzAoc = (await one("select id from public.aocs where code <> 'MY' limit 1;"))?.id;
    if (zzAoc) {
      const zzDept = (await one("select id from public.departments where aoc_id = $1 limit 1;", [zzAoc]))?.id ?? null;
      const zzMgr = await createUser('scope-zz-opmgr');
      const ins = await expectFail(() => db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [zzMgr, roleMap.get('operation_manager'), zzAoc, zzDept]));
      if (!ins.failed) {
        assert((await sv(zzMgr, 'KUL - MAA')) === false && (await readCount(zzMgr, 'stations')) === 0, 'an operation_manager in another AOC reaches no MY legacy data (compat mapping cannot bypass canonical scope)');
      }
    }

    // profiles: others' rows need scope
    await simulateUser(kulDse);
    const seen = (await db.query('select id from public.profiles;')).rows.map((r) => r.id);
    await simulateService();
    assert(seen.includes(kulDse) && !seen.includes(penDse), 'profiles: a dse reads itself and its own scope, not another station');
    await simulateUser(refForged);
    const forgedSeen = (await db.query('select id from public.profiles;')).rows.map((r) => r.id);
    await simulateService();
    assert(forgedSeen.length === 1 && forgedSeen[0] === refForged, 'a forged MANAGEMENT profile reads only its own profile row');

    // (f) security-definer functions executable by clients: identity-gating inventory
    const definers = (await db.query(
      "select p.proname, p.prorettype::regtype::text as ret, p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.prokind='f' and has_function_privilege('authenticated', p.oid, 'execute');",
    )).rows;
    const gate = /auth[.]uid\(\)|auth[.]role\(\)|canon_|has_active_role|has_role_in_scope|has_any_active|is_entity_admin|can_user_|can_acknowledge|can_view_report|my_aoc_id|current_status|current_station|current_team|is_announcement_visible|is_super_admin|has_active_entity/i;
    const ungated = definers.filter((f) => f.ret !== 'trigger' && !gate.test(f.prosrc)).map((f) => f.proname);
    console.log('INFO: security-definer functions executable by authenticated with no inline identity reference:', ungated.length, ungated.join(','));
  }

  console.log('\n--- SECTION 9: migration is idempotent ---');
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261020000001_canonical_operations_compatibility.sql'), 'utf8');
    const before = (await db.query("select count(*)::int as n from pg_policies where schemaname='public';")).rows[0].n;
    await db.exec('reset role;');
    await db.exec(sql);
    await simulateService();
    const after = (await db.query("select count(*)::int as n from pg_policies where schemaname='public';")).rows[0].n;
    assert(before === after, 'a second application leaves the policy set unchanged');
  }

  console.log(`\nCanonical compatibility verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();
  if (!isNative) fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
