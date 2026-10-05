// Phase 9 final Hub receipt at KCH/BKI (20261022000001): decision-table verification.
//  Only sso/so/aso at KCH or BKI (assignment station == destination) may confirm the final receipt; scanning stays
//  PEN/JHB only and is independent of receipt. Run from this directory after `node migrate.mjs`:
//    node verify_caterlink_receipt_authorization.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_receipt_authz_run');

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
  const runDb = 'vecta_receipt_authz_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== CaterLink receipt authorization verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== CaterLink receipt authorization verification against PGlite embedded engine ===');
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
  let seq = 0xc00;
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
  const STATION_ROLES = new Set(['sso', 'so', 'aso', 'dse', 'sat_aso', 'profiling_so', 'profiling_aso']);
  async function createUser(label, { status = 'approved' } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `rcpt-${label}@example.test`]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, status = excluded.status;",
      [id, `rcpt-${label}@example.test`, `Rcpt ${label}`, `RC-${label}`.slice(0, 20), status],
    );
    return id;
  }
  async function assign(profileId, code, st, { dept = opsDept, unit = null, timing = {} } = {}) {
    const needsMembership = !['operation_manager', 'main_enforcement', 'caterlink_management', 'compliance'].includes(code);
    let membershipId = null;
    if (needsMembership) {
      membershipId = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [profileId, myAoc, myEntity])).id;
    }
    const team = st && STATION_ROLES.has(code) ? await teamFor(st) : null;
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now() - interval '1 day'), $11, $12);`,
      [profileId, roleMap.get(code), myAoc, dept, unit, st ? st.hub_id : null, st && STATION_ROLES.has(code) ? st.id : null, team, membershipId, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null],
    );
  }
  const unitId = async (dept, code) => (await one('select id from public.units where department_id = $1 and code = $2;', [dept, code]))?.id ?? null;

  const KUL = await stationRow('KUL - MAA');
  const PEN = await stationRow('PEN');
  const JHB = await stationRow('JHB');
  const KCH = await stationRow('KCH');
  const BKI = await stationRow('BKI');
  const BTU = await stationRow('BTU');

  const canConfirm = async (id, station) => {
    await simulateUser(id);
    try { return (await one('select public.can_user_confirm_caterlink_receipt($1, null) as r;', [station])).r; } finally { await simulateService(); }
  };
  const canScan = async (id, station) => {
    await simulateUser(id);
    try { return (await one('select public.can_user_scan_caterlink($1, null) as r;', [station])).r; } finally { await simulateService(); }
  };
  const sender = await createUser('sender');
  await assign(sender, 'aso', KUL);
  let txSeq = 0;
  const newTx = async (extra = {}) => {
    const n = `RCPT-${Date.now()}-${++txSeq}`;
    // fixture insert only: the whitelist trigger is bypassed for the row, never for the receipt RPC under test
    await db.exec('reset role; set session_replication_role = replica;');
    try { return (await one(
      `insert into public.transactions (transaction_number, aoc_id, operating_entity_id, direction, vehicle_number, driver_name, driver_id, status, route, origin_station_id, created_by)
       values ($1, $2, $3, 'OUTBOUND', $4, 'Fixture Driver', 'DRV-1', $5, $6, $7, $8) returning id, transaction_number;`,
      [n, myAoc, myEntity, `VEH-${txSeq}`, extra.status ?? 'POST6_APPROVED', extra.route ?? 'AIRCRAFT', KUL.id, sender],
    )); } finally { await db.exec('set session_replication_role = origin;'); await simulateService(); }
  };
  const receipt = async (id, txId, station) => {
    await simulateUser(id);
    // NOTE: on error the caller's expectFail rolls back the savepoint; the role is restored by that caller.
    const r = await one("select * from public.confirm_caterlink_destination_receipt_secure($1, $2, 'sig_fixture.png', 'fixture');", [txId, station]);
    await simulateService();
    return r;
  };
  const tryReceipt = async (id, txId, station) => {
    const r = await expectFail(() => receipt(id, txId, station));
    await simulateService();
    return r;
  };

  console.log('\n--- SECTION 1: configuration ---');
  const caps = Object.fromEntries((await db.query("select s.code, c.* from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id;")).rows.map((r) => [r.code, r]));
  for (const code of ['KCH', 'BKI']) {
    const c = caps[code];
    assert(c && c.can_confirm_hub_receipt === true && c.is_active === true, `${code}: final hub receipt capability enabled`);
    assert(c.can_scan === false && c.can_create === false && c.can_confirm_station_receipt === false && c.can_download_pdf === false, `${code}: scanning, creation, intermediate station receipt and PDF download are NOT granted (view / incident / history flags are the pre-existing Phase 9 configuration, untouched here)`);
  }
  const scanEnabled = Object.entries(caps).filter(([, v]) => v.can_scan).map(([k]) => k).sort();
  assert(scanEnabled.join() === 'JHB,PEN', `scan configuration preserved exactly: JHB,PEN (found ${scanEnabled.join(',')})`);
  assert(caps['PEN'].can_confirm_hub_receipt === true && caps['JHB'].can_confirm_hub_receipt === true && (caps['BTU'] === undefined || caps['BTU'].can_confirm_hub_receipt === false), 'existing PEN/JHB receipt configuration preserved; BTU has none');
  const alphaCount = async (st) => (await one("select count(*)::int n from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).n;
  assert((await alphaCount(KCH)) === 1 && (await alphaCount(BKI)) === 1, 'exactly one canonical ALPHA team at KCH and at BKI (no duplicates)');
  const sigs = (await db.query("select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = 'can_user_confirm_caterlink_receipt'")).rows.map((r) => r.a);
  assert(sigs.length === 1 && !/profile/.test(sigs[0]), 'one decision function; it takes no caller-supplied identity');
  const def = (await one("select pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure) as d;")).d;
  assert(/auth\.uid\(\)/.test(def) && /status = 'approved'/.test(def) && /'sso', 'so', 'aso'/.test(def), 'decision derives identity from auth.uid(), requires an approved profile and sso/so/aso');
  assert(!/hub_se|operation_manager|main_enforcement|super_admin|ops_group|current_role_name|ADMIN/.test(def.replace(/--[^\n]*/g, '')), 'no management / compat / legacy bypass in the decision');
  const priv = await one("select has_function_privilege('anon','public.can_user_confirm_caterlink_receipt(text, uuid)','execute') a, has_function_privilege('authenticated','public.can_user_confirm_caterlink_receipt(text, uuid)','execute') b, has_function_privilege('anon','public.confirm_caterlink_destination_receipt_secure(uuid,text,text,text)','execute') c;");
  assert(priv.a === false && priv.b === true && priv.c === false, 'grants: anon denied, authenticated granted');

  console.log('\n--- SECTION 2: ALLOWED -- eligible officers confirm final receipt at their own station ---');
  const officers = {};
  for (const [label, st] of [['KCH', KCH], ['BKI', BKI]]) {
    for (const role of ['sso', 'so', 'aso']) {
      const id = await createUser(`${role}-${label}`);
      await assign(id, role, st);
      officers[`${role}-${label}`] = id;
      assert((await canConfirm(id, label)) === true, `${label} ${role}: receipt decision allowed`);
      assert((await canScan(id, label)) === false, `${label} ${role}: scan denied (receipt never grants scanning)`);
      const tx = await newTx();
      const before = await one('select * from public.transactions where id = $1;', [tx.id]);
      const auditBefore = (await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_receipt_confirm' and entity_id = $1;", [tx.id])).n;
      const r = await receipt(id, tx.id, label);
      assert(r.status === 'COMPLETED', `${label} ${role}: final receipt confirmed through the RPC`);
      const after = await one('select * from public.transactions where id = $1;', [tx.id]);
      const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
      assert(changed.every((k) => ['status', 'completed_at', 'destination_station_id', 'updated_at'].includes(k)) && changed.includes('status'), `${label} ${role}: only the final receipt fields changed (${changed.join(',')})`);
      const auditAfter = (await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_receipt_confirm' and entity_id = $1;", [tx.id])).n;
      assert(auditAfter === auditBefore + 1, `${label} ${role}: the receipt is audited`);
      const again = await expectFail(() => receipt(id, tx.id, label));
      await simulateService();
      assert(again.failed && /already completed/.test(again.error.message), `${label} ${role}: the receipt cannot be repeated`);
    }
  }

  console.log('\n--- SECTION 3: DENIED -- stations, roles, states, anonymous ---');
  const cross = [['KCH', 'BKI'], ['BKI', 'KCH']];
  for (const [home, target] of cross) {
    for (const role of ['sso', 'so', 'aso']) {
      const id = officers[`${role}-${home}`];
      assert((await canConfirm(id, target)) === false, `${home} ${role} cannot confirm at ${target}`);
      const tx = await newTx();
      assert((await tryReceipt(id, tx.id, target)).failed, `${home} ${role}: receipt RPC at ${target} refused`);
    }
  }
  for (const [label, st] of [['KUL - MAA', KUL], ['PEN', PEN], ['JHB', JHB], ['BTU', BTU]]) {
    const id = await createUser(`aso-at-${label.replace(/\W/g, '')}`);
    const made = await expectFail(() => assign(id, 'aso', st));
    if (made.failed) continue;
    for (const target of ['KCH', 'BKI']) assert((await canConfirm(id, target)) === false, `${label} aso cannot confirm at ${target}`);
    if (label === 'BTU') assert((await canConfirm(id, 'BTU')) === false, 'BTU aso: no receipt capability configured -> denied');
  }
  const dseKul = await createUser('dse-kul'); await assign(dseKul, 'dse', KUL);
  assert((await canConfirm(dseKul, 'KCH')) === false && (await canConfirm(dseKul, 'BKI')) === false, 'dse is not an eligible receipt role and has no KCH/BKI scope');
  const hubSe = await createUser('hub-se'); await assign(hubSe, 'hub_se', KCH);
  const opMgr = await createUser('op-mgr'); await assign(opMgr, 'operation_manager', null);
  const mainEnf = await createUser('main-enf'); await assign(mainEnf, 'main_enforcement', null, { dept: enfDept });
  const clMgmt = await createUser('cl-mgmt'); await assign(clMgmt, 'caterlink_management', null, { dept: await deptId('caterlink') });
  const compl = await createUser('compliance'); await assign(compl, 'compliance', null, { dept: await deptId('compliance') });
  const maaBoss = await createUser('maa-boss');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [maaBoss, roleMap.get('maa_boss'), myAoc, myEntity]);
  const ghod = await createUser('ghod');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1,$2, now() - interval '1 day');", [ghod, roleMap.get('ghod')]);
  const superAdmin = await createUser('super-admin');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1,$2, now() - interval '1 day');", [superAdmin, roleMap.get('super_admin')]);
  const inv = await createUser('investigation'); await assign(inv, 'investigation_aso', null, { dept: enfDept, unit: await unitId(enfDept, 'investigation') });
  const sat = await createUser('sat'); await assign(sat, 'sat_aso', KUL, { dept: enfDept, unit: await unitId(enfDept, 'sat') });
  const profAso = await createUser('prof-aso'); await assign(profAso, 'profiling_aso', PEN, { dept: enfDept, unit: await unitId(enfDept, 'profiling') });
  for (const [label, id] of [['hub_se', hubSe], ['operation_manager', opMgr], ['main_enforcement', mainEnf], ['caterlink_management', clMgmt], ['compliance', compl], ['maa_boss', maaBoss], ['ghod', ghod], ['super_admin', superAdmin], ['investigation', inv], ['sat', sat], ['profiling', profAso]]) {
    for (const st of ['KCH', 'BKI']) {
      assert((await canConfirm(id, st)) === false, `${label}: receipt denied at ${st}`);
      const tx = await newTx();
      assert((await tryReceipt(id, tx.id, st)).failed, `${label}: receipt RPC refused at ${st}`);
    }
  }
  for (const status of ['pending', 'rejected', 'deactivated']) {
    const id = await createUser(`state-${status}`, { status });
    await assign(id, 'aso', KCH);
    assert((await canConfirm(id, 'KCH')) === false, `${status} profile with a valid KCH assignment: denied`);
    const tx = await newTx();
    assert((await tryReceipt(id, tx.id, 'KCH')).failed, `${status} profile: receipt RPC refused`);
  }
  const revoked = await createUser('s-revoked'); await assign(revoked, 'aso', KCH, { timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } });
  const expired = await createUser('s-expired'); await assign(expired, 'aso', KCH, { timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } });
  const future = await createUser('s-future'); await assign(future, 'aso', KCH, { timing: { starts: new Date(Date.now() + 86400_000).toISOString() } });
  for (const [label, id] of [['revoked', revoked], ['expired', expired], ['future', future]]) {
    assert((await canConfirm(id, 'KCH')) === false, `${label} assignment: denied`);
    const tx = await newTx();
    assert((await tryReceipt(id, tx.id, 'KCH')).failed, `${label} assignment: receipt RPC refused`);
  }
  const inactiveRole = await createUser('s-inactive-role'); await assign(inactiveRole, 'sso', BKI);
  await db.query("update public.role_definitions set is_active = false where code = 'sso';");
  const inactiveResult = await canConfirm(inactiveRole, 'BKI');
  await db.query("update public.role_definitions set is_active = true where code = 'sso';");
  assert(inactiveResult === false, 'inactive role definition: denied');

  await db.exec('set role anon;');
  const anonCall = await expectFail(() => db.query("select * from public.confirm_caterlink_destination_receipt_secure('00000000-0000-0000-0000-000000000001', 'KCH', 'x', null);"));
  await simulateService();
  assert(anonCall.failed, 'anonymous caller cannot execute the receipt RPC');
  const noSub = await expectFail(async () => { await db.exec("select set_config('request.jwt.claims', '{}', true); select set_config('role','authenticated', true);"); try { await db.query("select * from public.confirm_caterlink_destination_receipt_secure('00000000-0000-0000-0000-000000000001', 'KCH', 'x', null);"); } finally { await simulateService(); } });
  assert(noSub.failed, 'an authenticated role with no subject is refused');

  console.log('\n--- SECTION 4: missing / inactive capability; receipt and scan are independent ---');
  await db.query("update public.caterlink_station_capabilities c set can_confirm_hub_receipt = false from public.org_stations s where s.id = c.station_id and s.code = 'KCH';");
  assert((await canConfirm(officers['aso-KCH'], 'KCH')) === false, 'KCH with the receipt capability switched off: denied');
  await db.query("update public.caterlink_station_capabilities c set can_confirm_hub_receipt = true from public.org_stations s where s.id = c.station_id and s.code = 'KCH';");
  await db.query("update public.caterlink_station_capabilities c set is_active = false from public.org_stations s where s.id = c.station_id and s.code = 'BKI';");
  assert((await canConfirm(officers['aso-BKI'], 'BKI')) === false, 'BKI with an inactive capability row: denied');
  await db.query("update public.caterlink_station_capabilities c set is_active = true from public.org_stations s where s.id = c.station_id and s.code = 'BKI';");
  const bkiRow = await one("select c.id from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where s.code = 'BKI';");
  await db.query('delete from public.caterlink_station_capabilities where id = $1;', [bkiRow.id]);
  assert((await canConfirm(officers['aso-BKI'], 'BKI')) === false, 'BKI with no capability row: denied (fails closed)');
  // restore the row exactly as the migration configures it
  await db.query("insert into public.caterlink_station_capabilities (aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt, can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active) values ($1,$2,false,false,false,false,true,false,false,false,true);", [myAoc, BKI.id]);
  assert((await canConfirm(officers['aso-BKI'], 'BKI')) === true, 'control: BKI receipt allowed again once the row is restored');
  // receipt capability does not grant scanning (KCH has receipt but no scan, even if scan were configured)
  await db.query("update public.caterlink_station_capabilities c set can_scan = true from public.org_stations s where s.id = c.station_id and s.code = 'KCH';");
  assert((await canScan(officers['aso-KCH'], 'KCH')) === false, 'even if a KCH scan flag were set, the reviewed scan allowlist keeps KCH scan denied');
  await db.query("update public.caterlink_station_capabilities c set can_scan = false from public.org_stations s where s.id = c.station_id and s.code = 'KCH';");
  // scan capability does not grant receipt
  const penAso = await createUser('aso-pen'); await assign(penAso, 'aso', PEN);
  const jhbAso = await createUser('aso-jhb'); await assign(jhbAso, 'aso', JHB);
  assert((await canScan(penAso, 'PEN')) === true && (await canConfirm(penAso, 'PEN')) === true, 'PEN (existing configuration): scan and receipt are each granted by their OWN capability');
  await db.query("update public.caterlink_station_capabilities c set can_confirm_hub_receipt = false, can_confirm_station_receipt = false from public.org_stations s where s.id = c.station_id and s.code = 'JHB';");
  assert((await canScan(jhbAso, 'JHB')) === true && (await canConfirm(jhbAso, 'JHB')) === false, 'JHB with receipt switched off: scan still allowed, receipt denied (scan never grants receipt)');
  await db.query("update public.caterlink_station_capabilities c set can_confirm_hub_receipt = true, can_confirm_station_receipt = true from public.org_stations s where s.id = c.station_id and s.code = 'JHB';");

  console.log('\n--- SECTION 5: no inference through the receipt RPC ---');
  const realTx = await newTx();
  const missing = '00000000-0000-0000-0000-00000000f00d';
  const msg = async (id, txId, st) => { const r = await expectFail(() => receipt(id, txId, st)); await simulateService(); return r.error?.message ?? '(no error)'; };
  const outsider = officers['aso-BKI'];
  const m1 = await msg(outsider, realTx.id, 'KCH');
  const m2 = await msg(outsider, missing, 'KCH');
  assert(m1 === m2 && /Not authorized/.test(m1), 'an unauthorized caller gets the same answer for an existing and a non-existent transaction');
  const mHub = await msg(hubSe, realTx.id, 'KCH');
  assert(mHub === m1, 'hub_se gets the identical answer');
  const own1 = await msg(officers['aso-KCH'], missing, 'KCH');
  assert(/not available/.test(own1) && !/escalated|completed|destination/.test(own1), 'even an authorized officer learns nothing about a transaction that is not theirs to confirm');

  console.log('\n--- SECTION 6: migration is idempotent ---');
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261022000001_phase9_caterlink_kch_bki_final_receipt.sql'), 'utf8');
    await db.exec('reset role;');
    await db.exec(sql);
    await simulateService();
    assert((await alphaCount(KCH)) === 1 && (await alphaCount(BKI)) === 1, 'a second application creates no duplicate team');
    assert((await canConfirm(officers['so-KCH'], 'KCH')) === true && (await canScan(officers['so-KCH'], 'KCH')) === false, 'a second application leaves behaviour unchanged');
    const scanEnabled2 = (await db.query("select s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where c.can_scan order by 1;")).rows.map((r) => r.code).join();
    assert(scanEnabled2 === 'JHB,PEN', 'PEN/JHB remain the only scan-enabled stations');
  }


  console.log(`\nCaterLink receipt authorization verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();
  if (!isNative) fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
