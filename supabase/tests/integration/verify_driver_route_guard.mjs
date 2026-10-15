// Driver route guard (20261112000001). Runs on PGlite (default) and on native PostgreSQL (--native).
// One RPC records the absence notice AND the same-day absent duty state in one transaction, deriving identity, station and team inside the
// database. Failure of either write leaves neither; the direct client write path to absence_notices is closed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_routeguard_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_routeguard_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Driver route guard against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Driver route guard against PGlite ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) { console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.'); process.exit(1); }
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
    fs.cpSync(GOLDEN_DATA_DIR, RUN_DATA_DIR, { recursive: true });
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    db = { exec: (s) => pgliteDb.exec(s), query: (s, p) => pgliteDb.query(s, p), close: () => pgliteDb.close() };
  }
  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');
  await db.exec(`
    create or replace function pg_temp.sim_user(p uuid) returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p::text, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true); end; $$;
    create or replace function pg_temp.sim_anon() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', true); perform set_config('role', 'anon', true); end; $$;
    create or replace function pg_temp.sim_service() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', true); perform set_config('role', 'service_role', true); end; $$;`);
  const sup = () => db.exec('select pg_temp.sim_service();');
  const one = async (s, p) => (await db.query(s, p)).rows[0];
  const rows = async (s, p) => (await db.query(s, p)).rows;
  await sup();
  let sp = 0;
  async function attempt(sess, fn) {
    const name = `s${++sp}`;
    await sess();
    await db.exec(`savepoint ${name};`);
    try { const r = await fn(); await db.exec(`release savepoint ${name};`); return { ok: true, r }; }
    catch (e) { await db.exec(`rollback to savepoint ${name}; release savepoint ${name};`); return { ok: false, err: e.message }; }
    finally { await sup(); }
  }
  const asUser = (u) => () => db.query('select pg_temp.sim_user($1)', [u]);
  const asAnon = () => db.exec('select pg_temp.sim_anon();');

  let seq = 0x9500;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
  const kul = await station('KUL - MAA'); const pen = await station('PEN');
  const team = async (st, name) => { await db.query('insert into public.org_teams (station_id, name) values ($1,$2) on conflict (station_id, name) do nothing;', [st.id, name]); return (await one('select id from public.org_teams where station_id = $1 and name = $2;', [st.id, name])).id; };
  const kulAlpha = await team(kul, 'ALPHA'); const penAlpha = await team(pen, 'ALPHA');
  const today = (await one("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).d;

  async function person(label, { st = kul, tm = kulAlpha, stTxt = 'KUL - MAA', tmTxt = 'ALPHA', status = 'approved', timing = {} } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing;', [id, `lv-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,$6,$7) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, team = excluded.team;", [id, `lv-${label}@example.test`, `LV ${label}`, `LV-${label}`.slice(0, 20), status, stTxt, tmTxt]);
    const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`, [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, tm, mem, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  const driver = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [driver, 'rg-driver@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'rg-driver@example.test','RG Driver','RG-DRV','ASO','approved') on conflict (id) do update set status = 'approved';", [driver]);
  await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'RG Driver','RG-DRV','rg-driver@example.test','warehouse_pic','active') on conflict (id) do update set role = 'warehouse_pic', status = 'active';", [driver]);
  const officer = await person('rgofficer', { st: pen, tm: penAlpha, stTxt: 'PEN', tmTxt: 'ALPHA' });
  const role = (await one("select public.caterlink_external_role() r")); void role;

  const asDriverDb = async (u, sql, p) => {
    // the driver acts through a privileged connection here only so the INSERT privilege is not the thing under test: identity is still the driver's
    await db.exec(`select set_config('request.jwt.claims', json_build_object('sub', '${u}', 'role', 'authenticated')::text, true), set_config('role', 'service_role', true);`);
    await db.exec('savepoint t;');
    try { await db.query(sql, p); await db.exec('rollback to savepoint t; release savepoint t;'); return { ok: true }; }
    catch (e) { await db.exec('rollback to savepoint t; release savepoint t;'); return { ok: false, err: e.message }; }
    finally { await sup(); }
  };
  const ins = (direction, route, hub) => `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, hub_destination, origin_station_id, created_by)
    values ('RG-${Math.random().toString(36).slice(2, 8)}', '${myAoc}', '${direction}', 'RG1', 'RG', 'RG', 'S', 'CREATED', '${route}', ${hub ? `'${hub}'` : 'null'}, '${pen.id}', '${driver}');`;
  const BLOCK = /not available yet/i;

  console.log('--- a Driver cannot create a movement whose route cannot complete (direct insert / RPC path) ---');
  for (const [d, r] of [['OUTBOUND', 'AIRCRAFT'], ['OUTBOUND', 'REDQ'], ['OUTBOUND', 'MAINTENANCE'], ['INBOUND', 'AIRCRAFT']]) {
    const res = await asDriverDb(driver, ins(d, r));
    assert(!res.ok && BLOCK.test(res.err), `Driver: ${d}/${r} is refused by the database`);
  }
  const hub = await asDriverDb(driver, ins('OUTBOUND', 'HUB', 'PEN'));
  assert(hub.ok || !BLOCK.test(hub.err), 'Driver: OUTBOUND/HUB is not refused by the route guard');

  console.log('--- a HUB movement must name a receiving hub, and any destination station must be that active station ---');
  const insDest = (hubDest, destId) => `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, hub_destination, origin_station_id, created_by, destination_station_id)
    values ('RG-${Math.random().toString(36).slice(2, 8)}', '${myAoc}', 'OUTBOUND', 'RG1', 'RG', 'RG', 'S', 'CREATED', 'HUB', ${hubDest === null ? 'null' : "'" + hubDest + "'"}, '${pen.id}', '${driver}', ${destId ? "'" + destId + "'" : 'null'});`;
  const kulRow = await one("select id from public.org_stations where code <> 'PEN' and is_active order by code limit 1");
  for (const [label, hubDest, destId] of [['no hub destination', null, null], ['a blank hub destination', '   ', null], ['a destination station id that is not the named hub station', 'PEN', kulRow.id]]) {
    const r = await asDriverDb(driver, insDest(hubDest, destId));
    assert(!r.ok && BLOCK.test(r.err), 'Driver: HUB with ' + label + ' is refused by the database');
  }
  await db.exec('reset role;');
  await db.query("update public.org_stations set is_active = false where code = 'PEN'");
  await sup();
  const inactive = await asDriverDb(driver, insDest('PEN', pen.id));
  assert(!inactive.ok && BLOCK.test(inactive.err), 'Driver: HUB with a destination id naming a deactivated station is refused by the database');
  await db.exec('reset role;');
  await db.query("update public.org_stations set is_active = true where code = 'PEN'");
  await sup();
  const unknown = await asDriverDb(driver, insDest('ZZZ', null));
  assert(!unknown.ok, 'Driver: HUB to an unknown hub code is refused (guard or table check)');
  const nilai = await asDriverDb(driver, insDest('NILAI', null));
  assert(nilai.ok || !BLOCK.test(nilai.err), 'Driver: HUB to NILAI (a hub without its own station row) is not refused by the route guard');
  const good = await asDriverDb(driver, insDest('PEN', pen.id));
  assert(good.ok || !BLOCK.test(good.err), 'Driver: HUB to an active station, with a matching destination id, is not refused by the route guard');

  console.log('--- other actors and the shared fixtures are unaffected ---');
  const off = await asDriverDb(officer, ins('OUTBOUND', 'AIRCRAFT'));
  assert(off.ok || !BLOCK.test(off.err), 'a station officer / non-driver actor is not subject to the Driver route guard');
  const fn = await one("select has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au from pg_proc p where p.proname = 'enforce_completable_driver_route' and p.pronamespace = 'public'::regnamespace;");
  assert(fn && !fn.an && !fn.au, 'the trigger function is not callable by clients');

  await db.exec('rollback;');
  await db.close();
  console.log(`
TOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
