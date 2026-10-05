// Phase 9 CaterLink scan authorization correction (20261021000001): decision-table verification.
//  Only station-level operational officers (sso/so/aso/dse) at PEN and JHB may scan; hub_se, operation_manager,
//  main_enforcement, caterlink_management, compliance, investigation, SAT, profiling, entity/global/super roles
//  and every non-approved / revoked / expired / future / inactive / cross-station state are denied.
//  Receipt confirmation is a separate permission. Run from this directory after `node migrate.mjs`:
//    node verify_caterlink_scan_authorization.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_scan_authz_run');

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
  const runDb = 'vecta_scan_authz_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== CaterLink scan authorization verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== CaterLink scan authorization verification against PGlite embedded engine ===');
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
  let seq = 0xa00;
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
  async function expectFail(fn) {
    await db.exec('savepoint sp_x;');
    try { await fn(); await db.exec('release savepoint sp_x;'); return { failed: false }; }
    catch (e) { await db.exec('rollback to savepoint sp_x; release savepoint sp_x;'); return { failed: true, error: e }; }
  }
  await simulateService();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const deptId = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
  const opsDept = await deptId('operation');
  const enfDept = await deptId('enforcement');
  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));
  const stationRow = async (code) => (await one('select id, hub_id from public.org_stations where code = $1;', [code]));
  const teamFor = async (st) => {
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]);
    return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id;
  };

  async function createUser(label, { status = 'approved' } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `scan-${label}@example.test`]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, status = excluded.status;",
      [id, `scan-${label}@example.test`, `Scan ${label}`, `SC-${label}`.slice(0, 20), status],
    );
    return id;
  }
  const STATION_ROLES = new Set(['sso', 'so', 'aso', 'dse', 'sat_aso', 'profiling_so', 'profiling_aso']);
  async function assign(profileId, code, st, { dept = opsDept, unit = null, timing = {} } = {}) {
    const needsMembership = !['operation_manager', 'main_enforcement', 'caterlink_management', 'compliance', 'maa_boss', 'maa_admin'].includes(code);
    let membershipId = null;
    if (needsMembership) {
      membershipId = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [profileId, myAoc, myEntity])).id;
    }
    const team = st && !['hub_se'].includes(code) ? await teamFor(st) : null;
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now() - interval '1 day'), $11, $12);`,
      [profileId, roleMap.get(code), myAoc, dept, unit, st ? st.hub_id : null, st && STATION_ROLES.has(code) ? st.id : null, team, membershipId, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null],
    );
  }
  const scan = async (id, station, aoc) => {
    await simulateUser(id);
    try {
      return (await one('select public.can_user_scan_caterlink($1, $2) as r;', [station, aoc ?? null])).r;
    } finally { await simulateService(); }
  };

  const PEN = await stationRow('PEN');
  const JHB = await stationRow('JHB');
  const KUL = await stationRow('KUL - MAA');
  const KCH = await stationRow('KCH');
  const BKI = await stationRow('BKI');
  const BTU = await stationRow('BTU');
  const unitId = async (dept, code) => (await one('select id from public.units where department_id = $1 and code = $2;', [dept, code]))?.id ?? null;

  console.log('\n--- SECTION 1: configuration after the correction ---');
  const caps = Object.fromEntries((await db.query("select s.code, c.can_scan, c.can_confirm_hub_receipt, c.can_confirm_station_receipt, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id;")).rows.map((r) => [r.code, r]));
  assert(caps['PEN']?.can_scan === true && caps['JHB']?.can_scan === true, 'PEN and JHB keep scanning enabled');
  const scanEnabled = Object.entries(caps).filter(([, v]) => v.can_scan).map(([k]) => k).sort();
  assert(scanEnabled.join() === 'JHB,PEN', `scanning is enabled at exactly PEN and JHB (found: ${scanEnabled.join(',')})`);
  assert(['KCH', 'BKI'].every((c) => caps[c] && caps[c].can_scan === false), 'KCH and BKI have NO scan capability');
  assert(caps['KUL - MAA']?.can_scan === false && caps['KUL - AAX']?.can_scan === false, 'KUL stations: scanning disabled');
  const sigs = (await db.query("select pg_get_function_identity_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'can_user_scan_caterlink' order by 1;")).rows.map((r) => r.a);
  assert(sigs.length === 1 && sigs[0] === 'p_station_code text, p_aoc_id uuid', `exactly one signature remains and it takes no caller-supplied profile id (found: ${sigs.join(' | ')})`);
  const def = (await one("select pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure) as d;")).d;
  assert(/auth\.uid\(\)/.test(def) && /status = 'approved'/.test(def) && /'sso', 'so', 'aso', 'dse'/.test(def), 'the function derives identity from auth.uid(), requires an approved profile and the four station-operator roles');
  assert(!/hub_se|operation_manager|main_enforcement|ops_group|current_role_name|ADMIN|super_admin/.test(def.replace(/--[^\n]*/g, '')), 'the function contains no management / compat / legacy bypass');

  console.log('\n--- SECTION 2: ALLOWED -- station operators at PEN and JHB ---');
  const allowed = {};
  for (const [stLabel, st] of [['PEN', PEN], ['JHB', JHB]]) {
    for (const role of ['sso', 'so', 'aso']) {
      const id = await createUser(`${role}-${stLabel}`);
      await assign(id, role, st);
      allowed[`${role}-${stLabel}`] = id;
      assert((await scan(id, stLabel)) === true, `${stLabel} ${role} may scan`);
    }
  }
  // dse is KUL-hub-only by the Phase 3 scope trigger, so a dse can never be assigned at PEN or JHB.
  const dseAtPen = await createUser('dse-pen');
  const dseReject = await expectFail(() => assign(dseAtPen, 'dse', PEN));
  assert(dseReject.failed, 'a dse cannot hold an assignment at PEN (KUL-hub-only): there is no PEN/JHB dse to authorize');
  const dseKul = await createUser('dse-kul');
  await assign(dseKul, 'dse', KUL);
  assert((await scan(dseKul, 'KUL - MAA')) === false, 'KUL dse: denied (station not scan-enabled)');
  // dse is explicitly eligible only where its station is scan-enabled: prove the role gate itself by temporarily enabling KUL
  await db.query("update public.caterlink_station_capabilities c set can_scan = true from public.org_stations s where s.id = c.station_id and s.code = 'KUL - MAA';");
  assert((await scan(dseKul, 'KUL - MAA')) === false, 'even with a (mis)configured KUL scan capability, the reviewed allowlist keeps KUL denied');
  await db.query("update public.caterlink_station_capabilities c set can_scan = false from public.org_stations s where s.id = c.station_id and s.code = 'KUL - MAA';");

  console.log('\n--- SECTION 3: DENIED -- stations without scanning ---');
  for (const [stLabel, st] of [['KUL - MAA', KUL], ['KCH', KCH], ['BKI', BKI], ['BTU', BTU]]) {
    for (const role of ['sso', 'so', 'aso']) {
      const id = await createUser(`${role}-${stLabel.replace(/\W/g, '')}`);
      const made = await expectFail(() => assign(id, role, st));
      if (made.failed) continue;
      assert((await scan(id, stLabel)) === false, `${stLabel} ${role}: denied`);
    }
  }
  // KCH / BKI: receipt confirmation is a SEPARATE permission. Receipt flags are not configured at these stations
  // today (and this migration does not change them); enable the receipt flag temporarily inside this rolled-back
  // transaction to prove that holding it never implies scanning.
  await db.query("update public.caterlink_station_capabilities c set can_confirm_hub_receipt = true, can_confirm_station_receipt = true from public.org_stations s where s.id = c.station_id and s.code in ('KCH', 'BKI');");
  for (const code of ['KCH', 'BKI']) {
    const receipt = (await one("select public.check_station_caterlink_capability($1, $2, 'confirm_hub_receipt') as r;", [myAoc, code])).r;
    const scanCap = (await one("select public.check_station_caterlink_capability($1, $2, 'scan') as r;", [myAoc, code])).r;
    assert(receipt === true && scanCap === false, `${code}: with hub receipt confirmation granted, scanning is still denied (receipt does not imply scan)`);
  }
  const kchOp = await createUser('aso-kch-receipt');
  await assign(kchOp, 'aso', KCH);
  assert((await scan(kchOp, 'KCH')) === false, 'KCH operator holding receipt capability still has no scan option');

  console.log('\n--- SECTION 4: DENIED -- roles that are not station operators ---');
  const hubSe = await createUser('hub-se'); await assign(hubSe, 'hub_se', PEN);
  const opMgr = await createUser('op-mgr'); await assign(opMgr, 'operation_manager', null);
  const mainEnf = await createUser('main-enf'); await assign(mainEnf, 'main_enforcement', null, { dept: enfDept });
  const clMgmt = await createUser('cl-mgmt'); await assign(clMgmt, 'caterlink_management', null, { dept: await deptId('caterlink') });
  const compl = await createUser('compliance'); await assign(compl, 'compliance', null, { dept: await deptId('compliance') });
  const maaBoss = await createUser('maa-boss');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [maaBoss, roleMap.get('maa_boss'), myAoc, myEntity]);
  const maaAdmin = await createUser('maa-admin');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [maaAdmin, roleMap.get('maa_admin'), myAoc, myEntity]);
  const ghod = await createUser('ghod');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1,$2, now() - interval '1 day');", [ghod, roleMap.get('ghod')]);
  const superAdmin = await createUser('super-admin');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1,$2, now() - interval '1 day');", [superAdmin, roleMap.get('super_admin')]);
  const invId = await createUser('investigation'); await assign(invId, 'investigation_aso', null, { dept: enfDept, unit: await unitId(enfDept, 'investigation') });
  const satId = await createUser('sat'); await assign(satId, 'sat_aso', KUL, { dept: enfDept, unit: await unitId(enfDept, 'sat') });
  const profSo = await createUser('prof-so'); await assign(profSo, 'profiling_so', PEN, { dept: enfDept, unit: await unitId(enfDept, 'profiling') });
  const profAso = await createUser('prof-aso'); await assign(profAso, 'profiling_aso', PEN, { dept: enfDept, unit: await unitId(enfDept, 'profiling') });
  for (const [label, id] of [['hub_se', hubSe], ['operation_manager', opMgr], ['main_enforcement', mainEnf], ['caterlink_management', clMgmt], ['compliance', compl], ['maa_boss', maaBoss], ['maa_admin', maaAdmin], ['ghod', ghod], ['super_admin', superAdmin], ['investigation', invId], ['sat', satId], ['profiling_so', profSo], ['profiling_aso', profAso]]) {
    for (const st of ['PEN', 'JHB', 'KUL - MAA']) {
      assert((await scan(id, st)) === false, `${label}: denied at ${st}`);
    }
  }
  // profiling combined with an operational role is ambiguous -> denied
  const profPlusAso = await createUser('prof-plus-aso');
  await assign(profPlusAso, 'aso', PEN);
  const pm = (await one("select id from public.user_entity_memberships where profile_id = $1 limit 1;", [profPlusAso])).id;
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '1 day');",
    [profPlusAso, roleMap.get('profiling_aso'), myAoc, enfDept, await unitId(enfDept, 'profiling'), PEN.hub_id, PEN.id, await teamFor(PEN), pm]);
  assert((await scan(profPlusAso, 'PEN')) === false, 'a profile holding both an operational and a profiling role is denied (ambiguous scope fails closed)');

  console.log('\n--- SECTION 5: DENIED -- account and assignment states ---');
  for (const status of ['pending', 'rejected', 'deactivated']) {
    const id = await createUser(`state-${status}`, { status });
    await assign(id, 'aso', PEN);
    assert((await scan(id, 'PEN')) === false, `${status} profile with an otherwise valid PEN assignment: denied`);
  }
  const revoked = await createUser('state-revoked'); await assign(revoked, 'aso', PEN, { timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } });
  const expired = await createUser('state-expired'); await assign(expired, 'aso', PEN, { timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } });
  const future = await createUser('state-future'); await assign(future, 'aso', PEN, { timing: { starts: new Date(Date.now() + 86400_000).toISOString() } });
  assert((await scan(revoked, 'PEN')) === false, 'revoked assignment: denied');
  assert((await scan(expired, 'PEN')) === false, 'expired assignment: denied');
  assert((await scan(future, 'PEN')) === false, 'future assignment: denied');
  const inactiveRole = await createUser('state-inactive-role'); await assign(inactiveRole, 'sso', PEN);
  await db.query("update public.role_definitions set is_active = false where code = 'sso';");
  const inactiveResult = await scan(inactiveRole, 'PEN');
  await db.query("update public.role_definitions set is_active = true where code = 'sso';");
  assert(inactiveResult === false, 'inactive role definition: denied');

  console.log('\n--- SECTION 6: DENIED -- scope, capability, identity ---');
  assert((await scan(allowed['aso-PEN'], 'JHB')) === false, 'a PEN assignment cannot scan at JHB (assignment for a different station)');
  assert((await scan(allowed['aso-JHB'], 'PEN')) === false, 'a JHB assignment cannot scan at PEN');
  assert((await scan(allowed['aso-PEN'], 'KUL - MAA')) === false, 'a PEN operator cannot scan at KUL');
  assert((await scan(allowed['aso-PEN'], 'PEN', '00000000-0000-0000-0000-00000000dead')) === false, 'a foreign / unknown AOC argument cannot widen scope');
  assert((await scan(allowed['aso-PEN'], null)) === false && (await scan(allowed['aso-PEN'], '')) === false && (await scan(allowed['aso-PEN'], 'UNKNOWN')) === false, 'missing, blank or unknown station fails closed');
  // missing capability row / inactive capability
  await db.query("update public.caterlink_station_capabilities c set is_active = false from public.org_stations s where s.id = c.station_id and s.code = 'PEN';");
  assert((await scan(allowed['aso-PEN'], 'PEN')) === false, 'inactive PEN capability: denied');
  await db.query("update public.caterlink_station_capabilities c set is_active = true from public.org_stations s where s.id = c.station_id and s.code = 'PEN';");
  await db.query("update public.caterlink_station_capabilities c set can_scan = false from public.org_stations s where s.id = c.station_id and s.code = 'JHB';");
  assert((await scan(allowed['aso-JHB'], 'JHB')) === false, 'JHB with scan disabled in configuration: denied');
  await db.query("update public.caterlink_station_capabilities c set can_scan = true from public.org_stations s where s.id = c.station_id and s.code = 'JHB';");
  const penRow = await one("select c.id, c.aoc_id, c.station_id from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where s.code = 'PEN';");
  await db.query('delete from public.caterlink_station_capabilities where id = $1;', [penRow.id]);
  assert((await scan(allowed['aso-PEN'], 'PEN')) === false, 'missing PEN capability row: denied');
  assert((await scan(allowed['aso-JHB'], 'JHB')) === true, 'control: JHB operator still allowed');
  // anonymous
  await db.exec('set role anon;');
  const anonCall = await expectFail(() => db.query("select public.can_user_scan_caterlink('PEN', null);"));
  await simulateService();
  assert(anonCall.failed, 'anonymous caller cannot execute the function');
  const noSub = await (async () => { await db.exec("select set_config('request.jwt.claims', '{}', true); select set_config('role','authenticated', true);"); try { return (await one("select public.can_user_scan_caterlink('PEN', null) as r;")).r; } finally { await simulateService(); } })();
  assert(noSub === false, 'an authenticated role without a subject (no auth.uid) is denied');
  // identity cannot be supplied
  const supplied = await expectFail(() => db.query("select public.can_user_scan_caterlink($1::uuid, $2::uuid, 'PEN');", [allowed['aso-PEN'], myAoc]));
  assert(supplied.failed, 'a caller-supplied profile id is rejected (no such overload)');
  const privs = (await one("select has_function_privilege('anon', 'public.can_user_scan_caterlink(text, uuid)', 'execute') as a, has_function_privilege('authenticated', 'public.can_user_scan_caterlink(text, uuid)', 'execute') as b, has_function_privilege('public', 'public.can_user_scan_caterlink(text, uuid)', 'execute') as p;"));
  assert(privs.a === false && privs.b === true, 'grants: anon none, authenticated yes');
  void privs.p;

  console.log('\n--- SECTION 7: receipt confirmation and scanning are separate permissions ---');
  const jhbReceipt = (await one("select public.check_station_caterlink_capability($1, 'JHB', 'confirm_hub_receipt') as r;", [myAoc])).r;
  assert(jhbReceipt === true, 'JHB: receipt capability present independently of the scan decision');
  assert((await one("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ilike '%can_user_scan_caterlink%' and p.proname not like 'can_user_scan_caterlink'")).n === 0, 'no database function derives other permissions from the scan decision (receipt/creation do not call it)');

  console.log('\n--- SECTION 8: migration is idempotent ---');
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261021000001_phase9_caterlink_scan_authorization_correction.sql'), 'utf8');
    await db.exec('reset role;');
    await db.exec(sql);
    await simulateService();
    assert((await scan(allowed['aso-JHB'], 'JHB')) === true, 'a second application leaves behaviour unchanged');
  }


  console.log(`\nCaterLink scan authorization verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();
  if (!isNative) fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
