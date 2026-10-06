// CaterLink external-actor workflows (20261025000001): Driver movement creation, Third-Party Vendor
// delivery workflow, authorization boundaries, hardening, idempotency and unchanged scan/receipt scope.
//    node verify_caterlink_external_workflows.mjs        (native PostgreSQL only; needs `node migrate.mjs --native` first)
//
// SYNTHETIC FIXTURES (local disposable database only): auth users, profiles, role assignments,
// whitelist rows (vehicle / driver / vendor company) and the external account rows. Nothing here is real data.
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG = (n) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', n), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures += 1; console.log('FAIL:', msg); return; }
  console.log('PASS:', msg);
}

async function main() {
  const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '55433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_cl_workflows_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== CaterLink external-workflow verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  const client = new Client({ ...pgConfig, database: runDb });
  await client.connect();
  const db = {
    exec: (sql) => client.query(sql),
    query: (sql, params) => client.query(sql, params),
    close: async () => {
      await client.end();
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
      await admin.query(`drop database if exists ${runDb};`);
      await admin.end();
    },
  };

  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');
  await db.exec(`
    create or replace function pg_temp.simulate_user(p_profile_id uuid) returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end; $$;
    create or replace function pg_temp.simulate_service_role() returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '{}', true);
      perform set_config('role', 'service_role', true);
    end; $$;
  `);
  const simulateUser = (id) => db.query('select pg_temp.simulate_user($1);', [id]);
  const simulateService = () => db.exec('select pg_temp.simulate_service_role();');
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  async function expectFail(fn) {
    await db.exec('savepoint sp_x;');
    try { await fn(); await db.exec('release savepoint sp_x;'); return { failed: false }; }
    catch (e) { await db.exec('rollback to savepoint sp_x; release savepoint sp_x;'); return { failed: true, error: e }; }
  }
  const asUser = async (id, fn) => { await simulateUser(id); try { return await fn(); } finally { await simulateService(); } };
  const asUserFail = async (id, fn) => { await simulateUser(id); try { return await expectFail(fn); } finally { await simulateService(); } };
  await simulateService();

  // ---- reproduce the STAGING shape of public.users (migration 63 creates it where the stub is absent) ----
  await db.exec('reset role;');
  await db.exec('drop table public.users cascade;');
  await db.exec(MIG('20261023000001_caterlink_external_account_table.sql'));
  await db.exec(MIG('20261024000001_canon_is_active_excludes_caterlink_only.sql'));
  await simulateService();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const deptId = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
  const opsDept = await deptId('operation');
  const clDept = await deptId('caterlink');
  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));
  const stationRow = async (code) => (await one('select id, hub_id from public.org_stations where code = $1;', [code]));
  const teamFor = async (st) => {
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]);
    return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id;
  };
  let seq = 0xe00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  async function authUser(label, { profile = true, status = 'approved' } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `wf-${label}@example.test`]);
    if (profile) {
      await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, status = excluded.status;", [id, `wf-${label}@example.test`, `WF ${label}`, `WF-${label}`.slice(0, 20), status]);
    }
    return id;
  }
  async function external(label, role, status = 'active') {
    const id = await authUser(label, { status: 'pending' }); // the signup trigger leaves external profiles pending
    await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,$6);", [id, `Ext ${label}`, `EX-${label}`.slice(0, 20), `wf-${label}@example.test`, role, status]);
    return id;
  }
  const STATION_ROLES = new Set(['sso', 'so', 'aso', 'dse']);
  async function assign(profileId, code, st) {
    const needsMembership = !['operation_manager', 'caterlink_management'].includes(code);
    let membershipId = null;
    if (needsMembership) {
      membershipId = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [profileId, myAoc, myEntity])).id;
    }
    const team = st ? await teamFor(st) : null;
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day');`,
      [profileId, roleMap.get(code), myAoc, code === 'caterlink_management' ? clDept : opsDept, st ? st.hub_id : null, st && STATION_ROLES.has(code) ? st.id : null, team, membershipId],
    );
  }

  // ---- capture the unchanged-scope baseline BEFORE applying the migration ----
  const capsBefore = JSON.stringify((await db.query("select s.code, c.can_create, c.can_scan, c.can_confirm_station_receipt, c.can_confirm_hub_receipt, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code;")).rows);
  const scanFnBefore = (await one("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) h;")).h;
  const receiptFnBefore = (await one("select md5(pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure)) h;")).h;
  const existingTables = (await db.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;")).rows.map((r) => r.table_name);

  // ---- fixtures ----
  const KULMAA = await stationRow('KUL - MAA');
  const PEN = await stationRow('PEN');
  const JHB = await stationRow('JHB');
  const KCH = await stationRow('KCH');
  const driverA = await external('driver-a', 'warehouse_pic');
  const driverB = await external('driver-b', 'warehouse_pic');
  const vendorA = await external('vendor-a', 'vendor');
  const vendorB = await external('vendor-b', 'vendor');
  const pendingDriver = await external('driver-pending', 'warehouse_pic', 'pending');
  const deactivatedVendor = await external('vendor-deactivated', 'vendor', 'deactivated');
  const mixed = await external('mixed', 'warehouse_pic');
  const mgmt = await authUser('mgmt'); await assign(mgmt, 'caterlink_management', null);
  const ops = await authUser('ops'); await assign(ops, 'operation_manager', null);
  const asoPen = await authUser('aso-pen'); await assign(asoPen, 'aso', PEN);
  const asoJhb = await authUser('aso-jhb'); await assign(asoJhb, 'aso', JHB);
  const asoKul = await authUser('aso-kul'); await assign(asoKul, 'aso', KULMAA);
  const asoKch = await authUser('aso-kch'); await assign(asoKch, 'aso', KCH);
  await assign(mixed, 'operation_manager', null);
  const noAccount = await authUser('no-account');
  // synthetic whitelist rows usable in AOC MY
  await db.query("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ('WF Caterer', 'WFC', $1, 'active', true, current_date - 1);", [myAoc]);
  const wfCo = (await one("select id from public.catering_companies where code = 'WFC';")).id;
  await db.query("insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ('WF1234A', $1, $2, 'active', true, current_date - 1);", [wfCo, myAoc]);
  await db.query("insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ('WF Driver', 'WFD001', $1, $2, 'active', true, current_date - 1);", [wfCo, myAoc]);
  const counts = async () => (await one("select (select count(*)::int from public.users) users, (select count(*)::int from public.user_role_assignments) assignments, (select count(*)::int from public.profiles) profiles;"));
  const dataBefore = await counts();

  // ---- apply the migration under test ----
  await db.exec('reset role;');
  await db.exec(MIG('20261025000001_caterlink_external_workflows.sql'));
  await simulateService();

  console.log('\n--- SECTION 1: additive, scope unchanged, hardening ---');
  {
    const after = (await db.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;")).rows.map((r) => r.table_name);
    const added = after.filter((t) => !existingTables.includes(t));
    assert(JSON.stringify(added) === JSON.stringify(['caterlink_vendor_checkpoints', 'caterlink_vendor_deliveries']), `exactly two tables are added (${added.join(', ')})`);
    assert(existingTables.every((t) => after.includes(t)), 'no existing table is dropped');
    const legacy = ['incidents', 'part_a', 'part_b', 'part_c', 'part_d', 'part_hub', 'part_redq', 'vendor_transactions', 'vendor_part_a', 'vendor_part_b', 'vendor_part_c', 'audit_logs', 'segment_timeouts', 'incident_photos'];
    assert(legacy.every((t) => !after.includes(t)), 'none of the 14 legacy ICMS tables is recreated');
    assert(JSON.stringify((await db.query("select s.code, c.can_create, c.can_scan, c.can_confirm_station_receipt, c.can_confirm_hub_receipt, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code;")).rows) === capsBefore, 'station capabilities (scan PEN/JHB, receipt KCH/BKI, create KUL) are byte-identical');
    assert((await one("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) h;")).h === scanFnBefore, 'can_user_scan_caterlink is unchanged');
    assert((await one("select md5(pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure)) h;")).h === receiptFnBefore, 'can_user_confirm_caterlink_receipt is unchanged');
    const d2 = await counts();
    assert(JSON.stringify(d2) === JSON.stringify(dataBefore), 'users, assignments and profiles are untouched by the migration');
    const bad = (await db.query(`select c.relname, r.rolname, p.priv from pg_class c cross join (values ('anon'),('authenticated')) r(rolname)
      cross join (values ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and c.relname = any(array['transactions','seals','seal_verifications','catering_companies','vehicles','drivers','caterlink_checkpoint_part_a','part_b_c','caterlink_checkpoint_part_d','caterlink_checkpoint_hub','caterlink_checkpoint_redq','caterlink_incidents','caterlink_incident_notes','caterlink_archives','caterlink_transaction_pdfs','caterlink_station_capabilities','users','caterlink_vendor_deliveries','caterlink_vendor_checkpoints'])
        and has_table_privilege(r.rolname, c.oid, p.priv);`)).rows;
    assert(bad.length === 0, `anon/authenticated hold no TRUNCATE/REFERENCES/TRIGGER on the CaterLink tables (${bad.length} found)`);
    const vt = await one("select has_table_privilege('authenticated','public.caterlink_vendor_deliveries','insert') i, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','update') u, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','delete') d, has_table_privilege('anon','public.caterlink_vendor_deliveries','select') a;");
    assert(!vt.i && !vt.u && !vt.d && !vt.a, 'authenticated cannot write vendor tables directly; anon has no access');
    const fnPriv = await one("select has_function_privilege('anon','public.create_caterlink_driver_transaction_secure(text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,integer,text[])','execute') a, has_function_privilege('anon','public.create_caterlink_vendor_delivery_secure(text,text,text,text,text,text,text,text)','execute') b;");
    assert(!fnPriv.a && !fnPriv.b, 'anon cannot execute the new RPCs');
  }

  const DRV_ARGS = (over = {}) => ({ station: 'KUL - MAA', dir: 'OUTBOUND', route: 'AIRCRAFT', veh: 'WF1234A', name: 'WF Driver', id: 'WFD001', seal: 'SEAL-0001', sig: 'signatures/wf-part-a.png', ...over });
  const createTx = (a) => db.query("select * from public.create_caterlink_driver_transaction_secure($1,$2,$3,$4,$5,$6,$7,$8);", [a.station, a.dir, a.route, a.veh, a.name, a.id, a.seal, a.sig]);

  console.log('\n--- SECTION 2: CaterLink Driver workflow ---');
  let txA;
  {
    const r = await asUser(driverA, () => createTx(DRV_ARGS()));
    txA = r.rows[0];
    assert(!!txA?.transaction_id && /^CL-\d{4}-\d{6}$/.test(txA.transaction_number), `Driver creates a movement (${txA?.transaction_number})`);
    const row = await one('select created_by, status, aoc_id, route, direction from public.transactions where id = $1;', [txA.transaction_id]);
    assert(row.created_by === driverA && row.status === 'CREATED' && row.aoc_id === myAoc, 'the row is owned by the Driver, CREATED, in the whitelist AOC');
    assert((await one('select count(*)::int n from public.seals where transaction_id = $1;', [txA.transaction_id])).n === 1, 'the initial seal is recorded');
    const pa = await one('select pic_name, pic_staff_id, completed_by from public.caterlink_checkpoint_part_a where transaction_id = $1;', [txA.transaction_id]);
    assert(pa.completed_by === driverA && pa.pic_staff_id === 'EX-driver-a', 'Part A records the Driver (name/staff id from the trusted account row, not client input)');
    assert((await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_driver_transaction_create';")).n >= 1, 'the creation is audited');

    const own = await asUser(driverA, async () => ({
      tx: (await db.query('select id from public.transactions;')).rows,
      pa: (await db.query('select transaction_id from public.caterlink_checkpoint_part_a;')).rows,
      seals: (await db.query('select id from public.seals;')).rows,
    }));
    assert(own.tx.length === 1 && own.tx[0].id === txA.transaction_id && own.pa.length === 1 && own.seals.length === 1, `the Driver reads its own movement, Part A and seal (${own.tx.length}/${own.pa.length}/${own.seals.length})`);

    const other = await asUser(driverB, async () => ({ tx: (await db.query('select id from public.transactions;')).rows.length, pa: (await db.query('select 1 from public.caterlink_checkpoint_part_a;')).rows.length, seals: (await db.query('select 1 from public.seals;')).rows.length }));
    assert(other.tx === 0 && other.pa === 0 && other.seals === 0, 'another Driver reads none of it (cross-user denial)');
    const v = await asUser(vendorA, async () => (await db.query('select 1 from public.transactions;')).rows.length);
    assert(v === 0, 'a Vendor reads no catering movements');
    const m = await asUser(mgmt, async () => ({ tx: (await db.query('select id from public.transactions;')).rows.length, pa: (await db.query('select 1 from public.caterlink_checkpoint_part_a;')).rows.length }));
    assert(m.tx === 1 && m.pa === 1, 'CaterLink Management reads the movement and its Part A in its AOC');
    const o = await asUser(ops, async () => (await db.query('select 1 from public.transactions;')).rows.length);
    assert(o === 1, 'Operation Manager read access to movements is unchanged');
    const nA = await asUser(noAccount, async () => (await db.query('select 1 from public.transactions;')).rows.length);
    assert(nA === 0, 'an account with no role reads nothing');

    for (const [label, id] of [['Vendor', vendorA], ['Management', mgmt], ['pending Driver', pendingDriver], ['mixed identity (external + assignment)', mixed], ['an account with no role', noAccount], ['an AVSEC officer', asoPen], ['Operation Manager', ops]]) {
      const r2 = await asUserFail(id, () => createTx(DRV_ARGS({ seal: `S-${label.length}` })));
      assert(r2.failed, `${label} cannot create a movement through the Driver RPC`);
    }
    const bits = [
      ['unknown vehicle', DRV_ARGS({ veh: 'NOTLISTED1', seal: 'S-X1' })],
      ['unknown driver id', DRV_ARGS({ id: 'NOPE999', seal: 'S-X2' })],
      ['a station without create capability (PEN)', DRV_ARGS({ station: 'PEN', seal: 'S-X3' })],
      ['an invalid direction', DRV_ARGS({ dir: 'SIDEWAYS', seal: 'S-X4' })],
      ['a missing signature', DRV_ARGS({ sig: '', seal: 'S-X5' })],
    ];
    for (const [label, args] of bits) {
      const r3 = await asUserFail(driverA, () => createTx(args));
      assert(r3.failed, `Driver creation is rejected for ${label}`);
    }
    for (const t of ['transactions', 'seals', 'caterlink_checkpoint_part_a']) {
      const w = await asUserFail(driverA, () => db.query(`insert into public.${t} (id) values (gen_random_uuid());`));
      const u = await asUserFail(driverA, () => db.query(`update public.${t} set id = id;`));
      const d = await asUserFail(driverA, () => db.query(`delete from public.${t};`));
      assert(w.failed && u.failed && d.failed, `${t}: a Driver cannot write directly (insert/update/delete denied)`);
    }
    const anon = await expectFail(async () => { await db.exec('set role anon;'); await db.query('select 1 from public.transactions;'); });
    await simulateService();
    assert(anon.failed, 'anon cannot read movements');
  }

  console.log('\n--- SECTION 3: Third-Party Vendor workflow ---');
  const createDel = (a) => db.query('select * from public.create_caterlink_vendor_delivery_secure($1,$2,$3,$4,$5,$6);', [a.station, a.driver, a.nric, a.vehicle, a.seal, a.sig]);
  const DEL = (over = {}) => ({ station: 'PEN', driver: 'V Driver', nric: 'S1234567A', vehicle: 'VND1234', seal: 'VS-001', sig: 'signatures/vendor-a.png', ...over });
  let delA;
  {
    delA = (await asUser(vendorA, () => createDel(DEL()))).rows[0];
    assert(!!delA?.delivery_id && /^CLV-\d{4}-\d{6}$/.test(delA.delivery_number), `Vendor creates a delivery (${delA?.delivery_number})`);
    const d = await one('select status, vendor_user_id, aoc_id from public.caterlink_vendor_deliveries where id = $1;', [delA.delivery_id]);
    assert(d.status === 'CREATED' && d.vendor_user_id === vendorA && d.aoc_id === myAoc, 'the delivery is CREATED, owned by the Vendor, in the station AOC');
    assert((await one("select count(*)::int n from public.caterlink_vendor_checkpoints where delivery_id = $1 and stage = 'A';", [delA.delivery_id])).n === 1, 'Part A is recorded');

    for (const [label, id] of [['Driver', driverA], ['Management', mgmt], ['pending/deactivated Vendor', deactivatedVendor], ['an AVSEC officer', asoPen], ['an account with no role', noAccount]]) {
      const r = await asUserFail(id, () => createDel(DEL({ seal: 'VS-DENY' })));
      assert(r.failed, `${label} cannot create a vendor delivery`);
    }
    for (const st of ['KCH', 'KUL - MAA', 'BKI', 'NOWHERE']) {
      const r = await asUserFail(vendorA, () => createDel(DEL({ station: st, seal: 'VS-ST' })));
      assert(r.failed, `a vendor delivery is rejected for ${st} (only scan-enabled PEN/JHB accept deliveries)`);
    }
    const seesDel = async (id) => asUser(id, async () => {
      const out = { d: 0, c: 0 };
      for (const [k, t] of [['d', 'caterlink_vendor_deliveries'], ['c', 'caterlink_vendor_checkpoints']]) {
        const r = await expectFail(async () => { out[k] = (await db.query(`select 1 from public.${t};`)).rows.length; });
        if (r.failed) { console.log(`   (query on ${t} failed: ${r.error.message})`); out[k] = 'ERR'; }
      }
      return out;
    });
    assert(JSON.stringify(await seesDel(vendorA)) === JSON.stringify({ d: 1, c: 1 }), 'the owning Vendor reads its delivery and checkpoints');
    assert(JSON.stringify(await seesDel(vendorB)) === JSON.stringify({ d: 0, c: 0 }), 'another Vendor reads none (cross-user denial)');
    assert(JSON.stringify(await seesDel(driverA)) === JSON.stringify({ d: 0, c: 0 }), 'a Driver reads no vendor workflow data');
    assert(JSON.stringify(await seesDel(mgmt)) === JSON.stringify({ d: 1, c: 1 }), 'CaterLink Management reads vendor deliveries in its AOC');
    assert(JSON.stringify(await seesDel(asoPen)) === JSON.stringify({ d: 1, c: 1 }), 'a scan-authorised officer at the delivery station reads it');
    assert(JSON.stringify(await seesDel(asoJhb)) === JSON.stringify({ d: 0, c: 0 }), 'a scan-authorised officer at another station does not');
    assert(JSON.stringify(await seesDel(asoKul)) === JSON.stringify({ d: 0, c: 0 }) && JSON.stringify(await seesDel(asoKch)) === JSON.stringify({ d: 0, c: 0 }), 'KUL and KCH officers (not scan-authorised) do not');
    const vTx = await asUser(vendorA, async () => (await db.query('select 1 from public.caterlink_checkpoint_part_a;')).rows.length);
    assert(vTx === 0, 'the Vendor reads no catering Part A either');

    const check = (id, delivery, result = 'PASS', reason = null) => db.query('select public.record_caterlink_vendor_security_check_secure($1,$2,$3,$4,$5,$6);', [delivery, 'signatures/sec.png', null, result, null, reason]);
    for (const [label, id] of [['the Vendor owner', vendorA], ['another Vendor', vendorB], ['a Driver', driverA], ['CaterLink Management', mgmt], ['Operation Manager', ops], ['a PEN-incapable KUL officer', asoKul], ['a KCH officer', asoKch], ['a JHB officer on a PEN delivery', asoJhb], ['an account with no role', noAccount]]) {
      const r = await asUserFail(id, () => check(id, delA.delivery_id));
      assert(r.failed, `${label} cannot record the security check (scanning is not granted to them)`);
    }
    assert((await one('select status from public.caterlink_vendor_deliveries where id = $1;', [delA.delivery_id])).status === 'CREATED', 'failed attempts leave the delivery CREATED');
    const early = await asUserFail(vendorA, () => db.query('select public.complete_caterlink_vendor_delivery_secure($1,$2);', [delA.delivery_id, 'signatures/done.png']));
    assert(early.failed, 'the Vendor cannot complete before the security check');

    await asUser(asoPen, () => check(asoPen, delA.delivery_id));
    assert((await one('select status from public.caterlink_vendor_deliveries where id = $1;', [delA.delivery_id])).status === 'SECURITY_VERIFIED', 'the PEN officer records the check -> SECURITY_VERIFIED');
    const twice = await asUserFail(asoPen, () => check(asoPen, delA.delivery_id));
    assert(twice.failed, 'the security check cannot be recorded twice');
    const bRow = await one("select actor_id, actor_staff_id from public.caterlink_vendor_checkpoints where delivery_id = $1 and stage = 'B';", [delA.delivery_id]);
    assert(bRow.actor_id === asoPen && bRow.actor_staff_id.startsWith('WF-aso-pen'), 'the check records the officer from the trusted profile');

    for (const [label, id] of [['another Vendor', vendorB], ['a Driver', driverA], ['Management', mgmt], ['an AVSEC officer', asoPen]]) {
      const r = await asUserFail(id, () => db.query('select public.complete_caterlink_vendor_delivery_secure($1,$2);', [delA.delivery_id, 'signatures/x.png']));
      assert(r.failed, `${label} cannot complete someone else's delivery`);
    }
    await asUser(vendorA, () => db.query('select public.complete_caterlink_vendor_delivery_secure($1,$2);', [delA.delivery_id, 'signatures/done.png']));
    const fin = await one('select status, completed_at from public.caterlink_vendor_deliveries where id = $1;', [delA.delivery_id]);
    assert(fin.status === 'COMPLETED' && fin.completed_at !== null, 'the owning Vendor completes after the check -> COMPLETED');
    const again = await asUserFail(vendorA, () => db.query('select public.complete_caterlink_vendor_delivery_secure($1,$2);', [delA.delivery_id, 'signatures/done2.png']));
    assert(again.failed, 'a completed delivery cannot be completed again');

    // escalation path
    const delE = (await asUser(vendorA, () => createDel(DEL({ station: 'JHB', seal: 'VS-ESC' })))).rows[0];
    const noReason = await asUserFail(asoJhb, () => check(asoJhb, delE.delivery_id, 'ESCALATE', null));
    assert(noReason.failed, 'an escalation needs a reason');
    await asUser(asoJhb, () => check(asoJhb, delE.delivery_id, 'ESCALATE', 'Seal mismatch'));
    assert((await one('select status from public.caterlink_vendor_deliveries where id = $1;', [delE.delivery_id])).status === 'ESCALATED', 'an escalated check -> ESCALATED');
    const blocked = await asUserFail(vendorA, () => db.query('select public.complete_caterlink_vendor_delivery_secure($1,$2);', [delE.delivery_id, 'signatures/x.png']));
    assert(blocked.failed, 'an escalated delivery cannot be completed by the Vendor');

    // immutability and direct-write denial
    const upd = await expectFail(() => db.query("update public.caterlink_vendor_checkpoints set remarks = 'x';"));
    const del = await expectFail(() => db.query('delete from public.caterlink_vendor_checkpoints;'));
    const delD = await expectFail(() => db.query('delete from public.caterlink_vendor_deliveries;'));
    assert(upd.failed && del.failed && delD.failed, 'checkpoints are write-once and deliveries are never deleted (even for the service role)');
    for (const t of ['caterlink_vendor_deliveries', 'caterlink_vendor_checkpoints']) {
      const w = await asUserFail(vendorA, () => db.query(`update public.${t} set created_at = created_at;`));
      const i = await asUserFail(vendorA, () => db.query(`insert into public.${t} (id) values (gen_random_uuid());`));
      assert(w.failed && i.failed, `${t}: the Vendor cannot write directly`);
    }
  }

  console.log('\n--- SECTION 4: CaterLink-only isolation from VECTA data ---');
  {
    const tables = ['report_sec014', 'team_rosters', 'duty_records', 'overtime_requests', 'absence_notices', 'bay_board', 'investigation_cases', 'announcements', 'discussion_threads', 'stations', 'shifts', 'report_sec013'];
    for (const [label, id] of [['Driver', driverA], ['Vendor', vendorA]]) {
      const leaks = {};
      for (const t of tables) {
        await simulateUser(id);
        const r = await expectFail(async () => { leaks[t] = (await one(`select count(*)::int n from public.${t};`)).n; });
        if (r.failed) leaks[t] = 0; // a permission error is also a denial
        await simulateService();
      }
      assert(Object.values(leaks).every((n) => n === 0), `${label} reads no VECTA table row (${JSON.stringify(Object.fromEntries(Object.entries(leaks).filter(([, n]) => n)))})`);
    }
    const ext = await asUser(mixed, () => one('select public.caterlink_external_role() r;'));
    assert(ext.r === null, 'a mixed identity (external row + canonical assignment) resolves to no external role');
    assert((await asUser(driverA, () => one('select public.caterlink_external_role() r;'))).r === 'warehouse_pic', 'Driver resolves to warehouse_pic from the trusted account row');
    assert((await asUser(vendorA, () => one('select public.caterlink_external_role() r;'))).r === 'vendor', 'Vendor resolves to vendor');
    assert((await asUser(pendingDriver, () => one('select public.caterlink_external_role() r;'))).r === null, 'a pending external account resolves to no role');
    assert((await asUser(mgmt, () => one('select public.caterlink_external_role() r;'))).r === null, 'Management is not an external actor');

    // scan and receipt scope unchanged for every actor
    for (const [label, id, st, want] of [['PEN officer', asoPen, 'PEN', true], ['JHB officer', asoJhb, 'JHB', true], ['KUL officer', asoKul, 'KUL - MAA', false], ['KCH officer', asoKch, 'KCH', false], ['Management', mgmt, 'PEN', false], ['Driver', driverA, 'PEN', false], ['Vendor', vendorA, 'PEN', false]]) {
      const r = await asUser(id, () => one('select public.can_user_scan_caterlink($1, null) r;', [st]));
      assert(r.r === want, `scan decision unchanged: ${label} at ${st} = ${want}`);
    }
    for (const [label, id] of [['Management', mgmt], ['Driver', driverA], ['Vendor', vendorA]]) {
      const r = await asUser(id, () => one("select public.can_user_confirm_caterlink_receipt('KCH', null) r;"));
      assert(r.r === false, `receipt decision unchanged: ${label} cannot confirm receipt`);
    }
  }

  console.log('\n--- SECTION 5: idempotent ---');
  {
    const pol = async () => (await one("select count(*)::int n from pg_policies where schemaname = 'public' and tablename like 'caterlink_%' or tablename = 'part_b_c';")).n;
    const before = await pol();
    await db.exec('reset role;');
    await db.exec(MIG('20261025000001_caterlink_external_workflows.sql'));
    await simulateService();
    assert((await pol()) === before, 'a second application leaves policies unchanged');
    assert((await one('select count(*)::int n from public.caterlink_vendor_deliveries;')).n === 2 && (await one('select count(*)::int n from public.transactions;')).n === 1, 'a second application keeps existing rows');
  }

  console.log(`\nCaterLink external-workflow verification completed. Total failures: ${failures}`);
  await db.exec('rollback;');
  await db.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
