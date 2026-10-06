// Storage policy findings and the two PROPOSED repairs (supabase/proposed-migrations/, not applied anywhere):
//   20261026000001_storage_upload_policy_repair.sql  -- every authenticated upload currently fails
//   20261026000002_signature_read_scoping.sql        -- any authenticated user can read/list every signature
//    node verify_storage_policies.mjs        (native PostgreSQL only; needs `node migrate.mjs --native` first)
//
// The disposable database reproduces staging: it is the migrated golden copy plus the legacy "signatures" bucket and
// the two legacy "signatures: authenticated ..." policies, created exactly as they exist on staging.
// SYNTHETIC FIXTURES: auth users, profiles, assignments, whitelist rows, movements, deliveries and storage rows.
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROPOSED = (n) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', n), 'utf8');
let failures = 0;
function assert(cond, msg) { if (!cond) { failures += 1; console.log('FAIL:', msg); return; } console.log('PASS:', msg); }

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_storage_policy_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Storage policy verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  const client = new Client({ ...pgConfig, database: runDb });
  await client.connect();
  const db = client;
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
  async function expectFail(fn) {
    await db.query('savepoint sp_x;');
    try { await fn(); await db.query('release savepoint sp_x;'); return { failed: false }; }
    catch (e) { await db.query('rollback to savepoint sp_x; release savepoint sp_x;'); return { failed: true, error: e }; }
  }
  const asUser = async (id, fn) => { await simulateUser(id); try { return await fn(); } finally { await simulateService(); } };
  const asUserFail = async (id, fn) => { await simulateUser(id); try { return await expectFail(fn); } finally { await simulateService(); } };
  await simulateService();

  // ---- staging-identical legacy state ----
  await db.query('reset role;');
  await db.query('drop table public.users cascade;');
  for (const f of ['20261023000001_caterlink_external_account_table.sql', '20261024000001_canon_is_active_excludes_caterlink_only.sql']) {
    await db.query(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f), 'utf8'));
  }
  // A golden database rebuilt by migrate.mjs already contains both repairs (it applies every dated root migration). Return it to the
  // STAGING pre-repair state so the run below proves the repairs from the defective state: the original insert policy, the legacy
  // blanket signature read, and none of the repair objects.
  await db.query('reset role;');
  await db.query(`drop trigger if exists trg_cl_sig_owner_part_a on public.caterlink_checkpoint_part_a;
    drop trigger if exists trg_cl_sig_owner_part_bc on public.part_b_c;
    drop trigger if exists trg_cl_sig_owner_part_d on public.caterlink_checkpoint_part_d;
    drop trigger if exists trg_cl_sig_owner_hub on public.caterlink_checkpoint_hub;
    drop trigger if exists trg_cl_sig_owner_redq on public.caterlink_checkpoint_redq;
    drop trigger if exists trg_cl_sig_owner_vendor on public.caterlink_vendor_checkpoints;
    drop policy if exists "signatures: scoped read" on storage.objects;
    drop policy if exists "report attachments object insert" on storage.objects;
    create policy "report attachments object insert" on storage.objects for insert
      with check (bucket_id = 'report-attachments' and exists (select 1 from get_report_submitter((storage.foldername(name))[1], nullif((storage.foldername(name))[2], '')::uuid) sub where sub.profile_id = auth.uid()));
    drop function if exists public.can_upload_report_attachment(text);
    drop function if exists public.caterlink_signature_visible(text);
    drop function if exists public.caterlink_signature_owner_guard();`);
  await db.query(`insert into storage.buckets (id, name, public) values ('signatures','signatures',false), ('incident-photos','incident-photos',false) on conflict (id) do nothing;
    create policy "signatures: authenticated upload" on storage.objects for insert with check (bucket_id = 'signatures' and auth.role() = 'authenticated');
    create policy "signatures: authenticated read" on storage.objects for select using (bucket_id = 'signatures' and auth.role() = 'authenticated');
    create policy "incident photos: authenticated upload" on storage.objects for insert with check (bucket_id = 'incident-photos' and auth.role() = 'authenticated');`);
  await simulateService();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const deptId = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
  const opsDept = await deptId('operation');
  const clDept = await deptId('caterlink');
  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));
  const stationRow = async (code) => (await one('select id, hub_id from public.org_stations where code = $1;', [code]));
  const teamFor = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };
  let seq = 0xf00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  async function authUser(label, status = 'approved') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `st-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status;", [id, `st-${label}@example.test`, `ST ${label}`, `ST-${label}`.slice(0, 20), status]);
    return id;
  }
  async function external(label, role) {
    const id = await authUser(label, 'pending');
    await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,'active');", [id, `Ext ${label}`, `EX-${label}`.slice(0, 20), `st-${label}@example.test`, role]);
    return id;
  }
  async function assign(profileId, code, st) {
    let membershipId = null;
    if (!['operation_manager', 'caterlink_management'].includes(code)) membershipId = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [profileId, myAoc, myEntity])).id;
    const team = st ? await teamFor(st) : null;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day');`,
      [profileId, roleMap.get(code), myAoc, code === 'caterlink_management' ? clDept : opsDept, st ? st.hub_id : null, st && ['sso', 'so', 'aso', 'dse'].includes(code) ? st.id : null, team, membershipId]);
  }
  const PEN = await stationRow('PEN'); const JHB = await stationRow('JHB');
  const driverA = await external('drv-a', 'warehouse_pic'); const driverB = await external('drv-b', 'warehouse_pic');
  const vendorA = await external('vnd-a', 'vendor'); const vendorB = await external('vnd-b', 'vendor');
  const mgmt = await authUser('mgmt'); await assign(mgmt, 'caterlink_management', null);
  const ops = await authUser('ops'); await assign(ops, 'operation_manager', null);
  const asoPen = await authUser('aso-pen'); await assign(asoPen, 'aso', PEN);
  const asoJhb = await authUser('aso-jhb'); await assign(asoJhb, 'aso', JHB);
  await db.query("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ('ST Caterer', 'STC', $1, 'active', true, current_date - 1);", [myAoc]);
  const co = (await one("select id from public.catering_companies where code = 'STC';")).id;
  for (const [veh, staff, name] of [['ST1111A', 'STD001', 'ST Driver A'], ['ST2222B', 'STD002', 'ST Driver B']]) {
    await db.query('insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ($1,$2,$3,$4,true,current_date - 1);', [veh, co, myAoc, 'active']);
    await db.query('insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ($1,$2,$3,$4,$5,true,current_date - 1);', [name, staff, co, myAoc, 'active']);
  }
  await db.query('reset role;');
  await db.query(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261025000001_caterlink_external_workflows.sql'), 'utf8'));
  await simulateService();

  const ins = (bucket, name, owner = null) => db.query('insert into storage.objects (bucket_id, name, owner) values ($1,$2,$3);', [bucket, name, owner]);

  console.log('\n--- SECTION 1: the upload defect reproduces (staging state) ---');
  {
    const f = await asUserFail(driverA, () => ins('signatures', 'probe/a.png', driverA));
    assert(f.failed && /permission denied for function get_report_submitter/.test(f.error.message), `an authenticated upload to the signatures bucket fails with the staging error (${f.error?.message})`);
    const g = await asUserFail(asoPen, () => ins('incident-photos', 'probe/b.png', asoPen));
    assert(g.failed && /get_report_submitter/.test(g.error.message), 'the same failure hits every bucket and every role (incident-photos, AVSEC officer)');
    assert(!(await one("select has_function_privilege('authenticated','public.get_report_submitter(text,uuid)','execute') a;")).a, 'cause: authenticated cannot execute get_report_submitter (revoked by 20260924000001)');
  }

  console.log('\n--- SECTION 2: proposed repair 1 (upload policy) ---');
  await db.query('reset role;');
  await db.query(PROPOSED('20261026000001_storage_upload_policy_repair.sql'));
  await simulateService();
  {
    await asUser(driverA, () => ins('signatures', 'probe/a.png', driverA));
    await asUser(asoPen, () => ins('incident-photos', 'probe/b.png', asoPen));
    assert((await one("select count(*)::int n from storage.objects where name in ('probe/a.png','probe/b.png');")).n === 2, 'authenticated uploads to signatures and incident-photos now succeed');
    const ra = await asUserFail(driverA, () => ins('report-attachments', 'sec014/00000000-0000-0000-0000-000000000099/x.pdf', driverA));
    assert(ra.failed && /row-level security/i.test(ra.error.message), 'a report-attachment upload for a report the caller did not file is still refused (same predicate, now an RLS denial)');
    const nofn = await asUserFail(driverA, () => db.query("select * from public.get_report_submitter('sec014', '00000000-0000-0000-0000-000000000099');"));
    assert(nofn.failed, 'get_report_submitter itself stays unexecutable for clients');
    assert((await one("select has_function_privilege('anon','public.can_upload_report_attachment(text)','execute') a, has_function_privilege('authenticated','public.can_upload_report_attachment(text)','execute') b;")).a === false, 'the wrapper is not executable by anon');
    assert((await one("select count(*)::int n from pg_policies where tablename = 'objects' and policyname = 'report attachments object insert';")).n === 1, 'exactly one report-attachments insert policy');
  }

  console.log('\n--- SECTION 3: signature exposure on the current policy (finding) ---');
  const mk = (sig, owner, args) => ({ sig, owner, args });
  // fixtures: two movements (Driver A, Driver B), two deliveries (Vendor A, Vendor B), orphan objects
  async function txFor(uid, vehicle, staff, name, sigPath) {
    return (await asUser(uid, () => one("select * from public.create_caterlink_driver_transaction_secure('KUL - MAA','OUTBOUND','AIRCRAFT',$1,$2,$3,$4,$5);", [vehicle, name, staff, `SEAL-${staff}`, sigPath])));
  }
  await txFor(driverA, 'ST1111A', 'STD001', 'ST Driver A', 'part-a/driver-a.png');
  await txFor(driverB, 'ST2222B', 'STD002', 'ST Driver B', 'part-a/driver-b.png');
  const dA = await asUser(vendorA, () => one("select * from public.create_caterlink_vendor_delivery_secure('PEN','D','N','V1','S1',$1);", ['vendor/vendor-a.png']));
  const dB = await asUser(vendorB, () => one("select * from public.create_caterlink_vendor_delivery_secure('PEN','D','N','V2','S2',$1);", ['vendor/vendor-b.png']));
  void dA; void dB;
  for (const [n, o] of [['part-a/driver-a.png', driverA], ['part-a/driver-b.png', driverB], ['vendor/vendor-a.png', vendorA], ['vendor/vendor-b.png', vendorB], ['orphan/nobody.png', null], ['part-a/driver-a-draft.png', driverA]]) await ins('signatures', n, o);
  const names = async (uid) => asUser(uid, async () => (await db.query("select name from storage.objects where bucket_id = 'signatures' order by name;")).rows.map((r) => r.name));
  const allCount = (await db.query("select count(*)::int n from storage.objects where bucket_id = 'signatures';")).rows[0].n;
  {
    const a = await names(driverA); const v = await names(vendorA);
    assert(a.length === allCount && v.length === allCount, `current policy: Driver A and Vendor A can list/read every signature object (${a.length} of ${allCount}) -- the OPEN finding`);
    assert(a.includes('part-a/driver-b.png') && a.includes('vendor/vendor-b.png') && v.includes('part-a/driver-a.png'), 'current policy: a Driver reads another Driver\'s and a Vendor\'s signatures, and a Vendor reads a Driver\'s');
  }

  console.log('\n--- SECTION 4: proposed repair 2 (scoped signature reads) ---');
  await db.query('reset role;');
  await db.query(PROPOSED('20261026000002_signature_read_scoping.sql'));
  await simulateService();
  {
    const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want.sort());
    assert(eq(await names(driverA), ['part-a/driver-a-draft.png', 'part-a/driver-a.png', 'probe/a.png']), 'Driver A reads only its own signature (referenced row + own upload)');
    assert(eq(await names(driverB), ['part-a/driver-b.png']), 'Driver B reads only its own');
    assert(eq(await names(vendorA), ['vendor/vendor-a.png']), 'Vendor A reads only its own delivery signature');
    assert(eq(await names(vendorB), ['vendor/vendor-b.png']), 'Vendor B reads only its own');
    assert(eq(await names(mgmt), ['part-a/driver-a.png', 'part-a/driver-b.png', 'vendor/vendor-a.png', 'vendor/vendor-b.png']), 'CaterLink Management reads every referenced signature (but not an unreferenced orphan)');
    assert(eq(await names(ops), ['part-a/driver-a.png', 'part-a/driver-b.png']), 'Operation Manager reads the movement signatures it can already see, not vendor ones');
    assert(eq(await names(asoPen), ['vendor/vendor-a.png', 'vendor/vendor-b.png']), 'a PEN officer reads the vendor signatures of deliveries it can check, not movements at KUL');
    assert(eq(await names(asoJhb), []), 'an unrelated officer reads none');
    const orphan = await asUser(driverA, async () => (await db.query("select 1 from storage.objects where name = 'orphan/nobody.png';")).rows.length);
    assert(orphan === 0, 'an unreferenced object owned by nobody is invisible to clients');
    // upload is unchanged
    await asUser(driverB, () => ins('signatures', 'part-a/driver-b-new.png', driverB));
    assert(eq(await names(driverB), ['part-a/driver-b-new.png', 'part-a/driver-b.png']), 'upload is unchanged and the uploader reads its own new object');
    // the legacy blanket policy is gone and nothing else grants a read
    assert((await one("select count(*)::int n from pg_policies where tablename = 'objects' and policyname = 'signatures: authenticated read';")).n === 0, 'the blanket read policy is gone');
    assert((await one("select count(*)::int n from pg_policies where tablename = 'objects' and cmd = 'SELECT' and qual ilike '%signatures%';")).n === 1, 'exactly one SELECT policy covers the signatures bucket');
  }

  console.log('\n--- SECTION 4b: every operation, every identity (repairs 1 + 2 applied) ---');
  {
    const norole = await authUser('norole');
    const people = { driverA, driverB, vendorA, vendorB, mgmt, ops, asoPen, asoJhb, norole };
    const label = (id) => Object.entries(people).find(([, v]) => v === id)?.[0];
    const allNames = (await db.query("select name from storage.objects where bucket_id = 'signatures';")).rows.map((r) => r.name);
    const mine = { driverA: ['part-a/driver-a.png', 'part-a/driver-a-draft.png', 'probe/a.png'], driverB: ['part-a/driver-b.png', 'part-a/driver-b-new.png'], vendorA: ['vendor/vendor-a.png'], vendorB: ['vendor/vendor-b.png'] };
    const unrelated = (who) => allNames.filter((n) => !(mine[who] ?? []).includes(n));
    for (const who of ['driverA', 'vendorA', 'driverB', 'vendorB']) {
      const id = people[who];
      const other = unrelated(who).filter((n) => !n.startsWith('probe/'));
      // LIST
      const listed = await asUser(id, async () => (await db.query("select name from storage.objects where bucket_id = 'signatures';")).rows.map((r) => r.name));
      assert(listed.every((n) => (mine[who] ?? []).includes(n)), `${who}: LIST shows none of another party's signatures (${listed.length} listed, all its own)`);
      // DOWNLOAD (select by exact name) and SIGNED URL (the storage API authorises it with the same SELECT)
      let leaked = 0;
      for (const n of other) leaked += await asUser(id, async () => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2;', ['signatures', n])).rows.length);
      assert(leaked === 0, `${who}: DOWNLOAD and SIGNED-URL authorisation (SELECT by exact path) is denied for all ${other.length} unrelated objects`);
      // UPDATE / overwrite and DELETE
      let changed = 0; let removed = 0;
      for (const n of other.concat(mine[who] ?? [])) {
        const u = await asUserFail(id, async () => { const r = await db.query("update storage.objects set name = name || '.x' where bucket_id = 'signatures' and name = $1;", [n]); if (r.rowCount) changed += r.rowCount; });
        const d = await asUserFail(id, async () => { const r = await db.query("delete from storage.objects where bucket_id = 'signatures' and name = $1;", [n]); if (r.rowCount) removed += r.rowCount; });
        void u; void d;
      }
      assert(changed === 0 && removed === 0, `${who}: UPDATE (overwrite/rename) and DELETE change nothing, even on its own objects (no policy grants them)`);
    }
    // INSERT: allowed, and the uploader can read it back
    for (const who of ['driverA', 'vendorA']) {
      const n = `new/${who}-upload.png`;
      await asUser(people[who], () => ins('signatures', n, people[who]));
      const back = await asUser(people[who], async () => (await db.query('select 1 from storage.objects where name = $1;', [n])).rows.length);
      const other = await asUser(people[who === 'driverA' ? 'vendorA' : 'driverA'], async () => (await db.query('select 1 from storage.objects where name = $1;', [n])).rows.length);
      assert(back === 1 && other === 0, `${who}: INSERT succeeds, the uploader reads it back, the other party does not`);
    }
    // authorised checkpoint users still reach exactly the signatures they may see
    const vis = async (who, n) => asUser(people[who], async () => (await db.query('select 1 from storage.objects where name = $1;', [n])).rows.length === 1);
    assert((await vis('mgmt', 'part-a/driver-a.png')) && (await vis('mgmt', 'vendor/vendor-b.png')), 'Management still reads the movement and vendor signatures of its AOC');
    assert((await vis('ops', 'part-a/driver-b.png')) && !(await vis('ops', 'vendor/vendor-a.png')), 'Operation Manager reads movement signatures it can see, not vendor ones');
    assert((await vis('asoPen', 'vendor/vendor-a.png')) && !(await vis('asoPen', 'part-a/driver-a.png')), 'the PEN officer reads the vendor signature it must check, not a KUL movement signature');
    assert(!(await vis('asoJhb', 'vendor/vendor-a.png')) && !(await vis('asoJhb', 'part-a/driver-a.png')), 'an unrelated officer (JHB, other station) reads neither');
    for (const who of ['asoJhb', 'norole']) {
      const n = await asUser(people[who], async () => (await db.query("select count(*)::int n from storage.objects where bucket_id = 'signatures';")).rows[0].n);
      assert(n === 0, `${who}: LIST shows nothing (no ownership, no visible record)`);
    }
    // Staff Profiling at PEN gains no signature access (it cannot check vendor deliveries)
    {
      const prof = await authUser('prof-aso');
      const enfDept = await deptId('enforcement');
      const unit = (await one("select id from public.units where department_id = $1 and code = 'profiling';", [enfDept]))?.id ?? null;
      const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [prof, myAoc, myEntity])).id;
      await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - interval '1 day');", [prof, roleMap.get('profiling_aso'), myAoc, enfDept, unit, PEN.hub_id, PEN.id, await teamFor(PEN), mem]);
      const n = await asUser(prof, async () => (await db.query("select count(*)::int n from storage.objects where bucket_id = 'signatures';")).rows[0].n);
      assert(n === 0, 'Staff Profiling at PEN: LIST shows nothing and no vendor/movement signature is readable');
    }
    // anon: no operation
    for (const [op, sql] of [['SELECT', "select * from storage.objects;"], ['INSERT', "insert into storage.objects (bucket_id, name) values ('signatures','anon.png');"], ['UPDATE', "update storage.objects set name = name;"], ['DELETE', "delete from storage.objects;"]]) {
      await db.query('select pg_temp.simulate_service_role();');
      await db.query('set role anon;');
      const r = await expectFail(() => db.query(sql));
      await simulateService();
      assert(r.failed, `anon: ${op} on storage.objects is denied`);
    }
    // a reference to someone else's signature cannot be used to read it (write-side guard)
    await ins('signatures', 'part-a/owned-by-b.png', driverB);
    const steal = await asUserFail(driverA, () => db.query("select * from public.create_caterlink_driver_transaction_secure('KUL - MAA','OUTBOUND','AIRCRAFT','ST1111A','ST Driver A','STD001','SEAL-STEAL','part-a/owned-by-b.png');"));
    assert(steal.failed && /different account/.test(steal.error.message), 'Driver A cannot create a record that references Driver B\'s signature object');
    const stealV = await asUserFail(vendorB, () => db.query("select * from public.create_caterlink_vendor_delivery_secure('PEN','D','N','V9','S9','vendor/vendor-a.png');"));
    assert(stealV.failed && /different account/.test(stealV.error.message), 'Vendor B cannot create a delivery that references Vendor A\'s signature object');
    assert(!(await vis('driverA', 'part-a/owned-by-b.png')), 'and the object stays unreadable to Driver A');
    const fine = await asUser(driverB, () => one("select * from public.create_caterlink_driver_transaction_secure('KUL - MAA','OUTBOUND','AIRCRAFT','ST2222B','ST Driver B','STD002','SEAL-OWN','part-a/owned-by-b.png');"));
    assert(!!fine.transaction_id, 'the real owner can reference its own signature object (the legitimate workflow still works)');
    // repair 1 wrapper properties
    const w = await one("select p.prosecdef d, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b, pg_get_function_result(p.oid) r from pg_proc p where p.proname = 'can_upload_report_attachment';");
    assert(w.d && w.c.some((x) => x.startsWith('search_path=')) && !w.a && w.b && w.r === 'boolean', 'wrapper: SECURITY DEFINER, pinned search_path, boolean result, anon denied, authenticated granted');
    const g = await one("select has_function_privilege('authenticated','public.get_report_submitter(text,uuid)','execute') a, has_function_privilege('anon','public.get_report_submitter(text,uuid)','execute') b, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = 'public.get_report_submitter(text,uuid)'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub;");
    assert(!g.a && !g.b && !g.pub, 'get_report_submitter is still executable by neither authenticated, anon nor PUBLIC');
    const tg = await one("select count(*)::int n from pg_trigger where tgname like 'trg_cl_sig_owner_%';");
    assert(tg.n === 6, 'the signature-owner guard is attached to all six checkpoint tables');
    const gp = await one("select has_function_privilege('anon','public.caterlink_signature_owner_guard()','execute') a, has_function_privilege('authenticated','public.caterlink_signature_owner_guard()','execute') b;");
    assert(!gp.a && !gp.b, 'the guard function is not callable by clients');
    const gs = await one("select has_function_privilege('anon','public.caterlink_signature_visible(text)','execute') a;");
    assert(!gs.a, 'the visibility check is not callable by anon');
  }

  console.log('\n--- SECTION 5: idempotent ---');
  {
    await db.query('reset role;');
    await db.query(PROPOSED('20261026000001_storage_upload_policy_repair.sql'));
    await db.query(PROPOSED('20261026000002_signature_read_scoping.sql'));
    await simulateService();
    assert((await one("select count(*)::int n from pg_policies where tablename = 'objects' and policyname in ('signatures: scoped read','report attachments object insert');")).n === 2, 'a second application leaves exactly the two repaired policies');
  }

  console.log(`\nStorage policy verification completed. Total failures: ${failures}`);
  await db.query('rollback;');
  await client.end();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.end();
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
