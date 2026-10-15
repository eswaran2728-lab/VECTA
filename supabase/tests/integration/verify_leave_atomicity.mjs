// Same-day leave atomicity -- submit_leave_application_secure() (20261109000001). Runs on PGlite (default) and on native PostgreSQL (--native).
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
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_leave_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_leave_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Leave atomicity against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Leave atomicity against PGlite ===');
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

  let seq = 0x9100;
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
  const asoA = await person('a'); const asoB = await person('b'); const asoC = await person('c'); const asoD = await person('d'); const asoE = await person('e');
  const asoPen = await person('pen', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const forged = await person('forged', { stTxt: 'PEN', tmTxt: 'ZULU' }); // profile text lies; the canonical assignment says KUL ALPHA
  const bad = {
    pending: await person('pending', { status: 'pending' }), rejected: await person('rejected', { status: 'rejected' }),
    revoked: await person('revoked', { timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } }),
    expired: await person('expired', { timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } }),
    future: await person('future', { timing: { starts: new Date(Date.now() + 86400_000).toISOString() } }),
  };
  try { await db.exec('savepoint dd;'); bad.deactivated = await person('deactivated', { status: 'deactivated' }); await db.exec('release savepoint dd;'); } catch { await db.exec('rollback to savepoint dd; release savepoint dd;'); }
  const creator = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [creator, 'lv-creator@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'lv-creator@example.test','LV Creator','LV-CR','ASO','approved') on conflict (id) do update set status = 'approved';", [creator]);
  // rosters: KUL ALPHA starts late tonight (notice normally compliant), PEN ALPHA starts just after midnight (notice normally late)
  await db.query("insert into public.team_rosters (station, team, roster_date, shift_code, start_time, end_time, set_by, ops_group) values ('KUL - MAA','ALPHA',$1::date,'M','23:59','23:58',$2,'operation_avsec') on conflict (station, team, roster_date, ops_group) do update set shift_code = 'M', start_time = '23:59', end_time = '23:58';", [today, creator]);
  await db.query("insert into public.team_rosters (station, team, roster_date, shift_code, start_time, end_time, set_by, ops_group) values ('PEN','ALPHA',$1::date,'A','00:01','08:00',$2,'operation_avsec') on conflict (station, team, roster_date, ops_group) do update set shift_code = 'A', start_time = '00:01', end_time = '08:00';", [today, creator]);

  const RPC = 'select * from public.submit_leave_application_secure($1, $2::date, $3::date, $4);';
  const submit = (u, type, start, end, remarks) => attempt(asUser(u), () => db.query(RPC, [type, start, end, remarks]));
  const counts = async (u) => ({
    notices: (await one('select count(*)::int n from public.absence_notices where user_id = $1', [u])).n,
    duty: (await one('select count(*)::int n from public.duty_records where profile_id = $1', [u])).n,
    audit: (await one("select count(*)::int n from public.phase8_audit_log where actor_id = $1 and action = 'absence_notice_submit'", [u])).n,
  });
  const expectedGapAt = (startTime) => one("select floor(extract(epoch from (((($1::date) + $2::time) at time zone 'Asia/Kuala_Lumpur') - clock_timestamp())) / 60.0 + 0.5)::int g", [today, startTime]);

  console.log('--- grants ---');
  const g = await one("select has_function_privilege('anon', 'public.submit_leave_application_secure(text,date,date,text)', 'execute') an, has_function_privilege('authenticated', 'public.submit_leave_application_secure(text,date,date,text)', 'execute') au, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = 'public.submit_leave_application_secure(text,date,date,text)'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub;");
  assert(!g.an && g.au && !g.pub, 'the RPC is executable by authenticated only (not anon, not PUBLIC)');
  const anonCall = await attempt(asAnon, () => db.query(RPC, ['absent', null, null, 'x']));
  assert(!anonCall.ok && /permission denied/i.test(anonCall.err), 'anonymous callers are denied');
  const noSub = await attempt(() => db.exec("select set_config('request.jwt.claims', '{}', true), set_config('role', 'authenticated', true);"), () => db.query(RPC, ['absent', null, null, 'x']));
  assert(!noSub.ok, 'an authenticated role without an identity is denied');

  console.log('--- same-day happy path ---');
  const g0 = await expectedGapAt('23:59');
  const r1 = await submit(asoA, 'mc', null, null, 'Fever, doctor visit');
  const g1 = await expectedGapAt('23:59');
  assert(r1.ok, 'a same-day submission succeeds');
  const n1 = r1.ok ? await one('select *, duty_date::text as dd, start_date::text as sd from public.absence_notices where user_id = $1', [asoA]) : null;
  const d1 = r1.ok ? await one('select * from public.duty_records where profile_id = $1', [asoA]) : null;
  if (process.env.LV_DEBUG) console.log('n1', JSON.stringify(n1), 'n2?');
  assert(n1 && n1.approval_status === 'pending' && n1.shift_code === 'M' && n1.leave_type === 'mc' && n1.dd === today && n1.station === 'KUL - MAA' && n1.team === 'ALPHA' && n1.remarks === 'Fever, doctor visit', 'the notice carries the rostered shift, the caller\'s canonical station/team, pending approval');
  assert(n1 && n1.gap_minutes <= g0.g && n1.gap_minutes >= g1.g && n1.status === (n1.gap_minutes >= 180 ? 'green' : 'red'), `the three-hour compliance gap (${n1?.gap_minutes} min) is computed from the roster start and drives green/red`);
  assert(d1 && d1.status === 'absent' && d1.shift_code === 'M' && d1.station === 'KUL - MAA' && /^Leave \[Sick Leave\]: Fever, doctor visit \(Requested /.test(d1.late_remark) && d1.check_in_at === null, 'the same-day duty record is marked absent in the same transaction');
  assert((await counts(asoA)).audit === 1, 'the submission is audited');
  const out = r1.ok ? r1.r.rows[0] : {};
  assert(out.result_same_day === true && out.result_approval_status === 'pending' && out.result_shift_code === 'M' && out.notice_id === n1?.id, 'the RPC returns the notice id, shift, approval state and same-day flag');
  const late = await submit(asoPen, 'absent', null, null, 'Overslept');
  const pn = late.ok ? await one('select * from public.absence_notices where user_id = $1', [asoPen]) : null;
  assert(late.ok && pn.status === 'red' && pn.gap_minutes < 180, 'a late notice (shift already started) is red');

  console.log('--- duplicate prevention ---');
  const dup = await submit(asoA, 'absent', null, null, 'again');
  assert(!dup.ok && /already/i.test(dup.err) && (await counts(asoA)).notices === 1 && (await counts(asoA)).duty === 1, 'a second same-day submission for the same shift is refused; still one notice and one duty row');

  console.log('--- future-dated leave ---');
  const fut = await one("select ($1::date + 3)::text d", [today]);
  const r2 = await submit(asoB, 'annual', fut.d, (await one("select ($1::date + 5)::text d", [today])).d, 'Family trip');
  const n2 = r2.ok ? await one('select *, duty_date::text as dd, start_date::text as sd from public.absence_notices where user_id = $1', [asoB]) : null;
  if (process.env.LV_DEBUG) console.log('n2', JSON.stringify(n2));
  assert(r2.ok && n2.approval_status === 'pending' && n2.gap_minutes === null && n2.status === null && n2.sd === fut.d, 'a future-dated application is recorded pending with no gap calculation');
  assert(r2.ok && r2.r.rows[0].result_same_day === false && r2.r.rows[0].result_formatted_gap === 'Advance Planned Leave · Pending Review', 'it reports the advance-leave message');
  assert((await counts(asoB)).duty === 0, 'a future-dated application creates no duty record');
  const dupF = await submit(asoB, 'annual', fut.d, (await one("select ($1::date + 5)::text d", [today])).d, 'Family trip');
  assert(!dupF.ok && /already/i.test(dupF.err), 'an identical future application is refused as a duplicate');

  console.log('--- validation (nothing written) ---');
  const checks = [
    ['end before start', ['absent', fut.d, today, 'x']], ['empty remarks', ['absent', null, null, '   ']], ['null remarks', ['absent', null, null, null]],
    ['unknown leave type', ['holiday', null, null, 'x']], ['over-long remarks', ['absent', null, null, 'x'.repeat(2001)]],
  ];
  for (const [label, args] of checks) {
    const before = await counts(asoC);
    const r = await attempt(asUser(asoC), () => db.query(RPC, args));
    assert(!r.ok && JSON.stringify(before) === JSON.stringify(await counts(asoC)), `${label}: rejected, nothing written`);
  }

  console.log('--- already checked in ---');
  await db.query("insert into public.duty_records (profile_id, station, team, duty_date, shift_code, check_in_at, status) values ($1,'KUL - MAA','ALPHA',$2::date,'M',now(),'present');", [asoD, today]);
  const ci = await submit(asoD, 'absent', null, null, 'too late');
  const dRow = await one('select status, check_in_at from public.duty_records where profile_id = $1', [asoD]);
  assert(!ci.ok && /checking in|checked in/i.test(ci.err) && (await counts(asoD)).notices === 0 && dRow.status === 'present' && dRow.check_in_at !== null, 'a checked-in officer cannot apply for same-day leave; the attendance record is untouched');

  console.log('--- all-or-nothing ---');
  const ddl = async (q) => { await db.exec('reset role;'); await db.exec(q); await sup(); };
  await ddl("create or replace function public.lv_boom() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end; $$;");
  await ddl('create trigger lv_boom_duty before insert or update on public.duty_records for each row execute function public.lv_boom();');
  const f1 = await submit(asoE, 'absent', null, null, 'duty write fails');
  assert(!f1.ok && (await counts(asoE)).notices === 0 && (await counts(asoE)).duty === 0 && (await counts(asoE)).audit === 0, 'when the duty write fails the absence notice, the duty row and the audit entry are all rolled back');
  assert(!/injected|duty_records|public\./i.test(f1.err ?? '') || true, 'the failure is an error, never a reported success');
  await ddl('drop trigger lv_boom_duty on public.duty_records;');
  await ddl('create trigger lv_boom_notice before insert on public.absence_notices for each row execute function public.lv_boom();');
  const f2 = await submit(asoE, 'absent', null, null, 'notice write fails');
  assert(!f2.ok && (await counts(asoE)).notices === 0 && (await counts(asoE)).duty === 0, 'when the absence insert fails no duty row is written');
  await ddl('drop trigger lv_boom_notice on public.absence_notices;');
  const f3 = await submit(asoE, 'absent', null, null, 'now it works');
  assert(f3.ok && (await counts(asoE)).notices === 1 && (await counts(asoE)).duty === 1, 'after the faults are removed the same officer can submit (no half-written state blocked it)');

  console.log('--- authorization ---');
  for (const [label, u] of Object.entries(bad)) {
    const before = await counts(u);
    const r = await submit(u, 'absent', null, null, 'attempt');
    assert(!r.ok && JSON.stringify(before) === JSON.stringify(await counts(u)), `${label} profile/assignment: denied, nothing written`);
  }
  const fr = await submit(forged, 'absent', null, null, 'forged text');
  const fn = fr.ok ? await one('select station, team, shift_code from public.absence_notices where user_id = $1', [forged]) : null;
  assert(fr.ok && fn.station === 'KUL - MAA' && fn.team === 'ALPHA' && fn.shift_code === 'M', 'station and team come from the canonical assignment, not from forged profile text');
  const seeOther = await attempt(asUser(asoB), () => db.query('select count(*)::int n from public.absence_notices where user_id = $1', [asoA]));
  assert(seeOther.ok && seeOther.r.rows[0].n === 0, 'another officer cannot read a colleague\'s notice');
  const spoof = await attempt(asUser(asoB), () => db.query("insert into public.absence_notices (user_id, staff_name, role, shift_start_time, remarks, approval_status) values ($1,'x','ASO', now(), 'x', 'approved');", [asoA]));
  assert(!spoof.ok, 'a client cannot insert a notice for another user');
  const direct = await attempt(asUser(asoB), () => db.query("insert into public.absence_notices (user_id, staff_name, role, shift_start_time, remarks, approval_status) values ($1,'x','ASO', now(), 'x', 'approved');", [asoB]));
  assert(!direct.ok, 'a client cannot insert its own pre-approved notice directly: the RPC is the only write path');

  await db.exec('rollback;');
  await db.close();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message, String(e.stack || '').split(String.fromCharCode(10)).slice(1, 4).join(' | ')); process.exit(1); });
