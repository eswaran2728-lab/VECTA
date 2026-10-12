// Assignment time-validity: a future-dated (and expired / revoked / pending) assignment must behave EXACTLY like no assignment at all,
// in every database function a signed-in client can call. Differential test: every no-argument, non-mutating function granted to
// `authenticated` is run as (a) an approved profile with NO assignment and (b) approved profiles whose only assignment is
// future-dated / expired / revoked. Any difference between (a) and (b) is an authorization leak. An ACTIVE ASO is the control that
// proves the harness can see a difference. Also targeted checks: has_active_role / has_role_in_scope for every role code, report
// access to a report in the user's own station, announcements, WOIS eligibility, CaterLink scan capability, directory/workforce RPCs.
// Native PostgreSQL only (run `node migrate.mjs --native` first). Synthetic fixtures in a disposable local database.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log('FAIL:', msg); } else { passes += 1; console.log('PASS:', msg); } };

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_time_validity_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Assignment time-validity verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  await admin.end();
  const db = new Client({ ...pgConfig, database: runDb });
  await db.connect();
  await db.query('set check_function_bodies = off;');
  await db.query(`
    create or replace function pg_temp.sim_user(p uuid) returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p::text, 'role', 'authenticated')::text, false); perform set_config('role', 'authenticated', false); end; $$;
    create or replace function pg_temp.sim_service() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', false); perform set_config('role', 'service_role', false); end; $$;`);
  const sup = () => db.query('select pg_temp.sim_service();');
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  await db.query('begin;');
  await sup();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roles = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [kul.id]);
  const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [kul.id])).id;
  let seq = 0x7100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;

  async function person(label, { status = 'approved', assignment = null } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `tv-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `tv-${label}@example.test`, `TV ${label}`, `TV-${label}`.slice(0, 20), status]);
    if (assignment) {
      const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
      await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);`, [id, roles.get('aso'), myAoc, opsDept, kul.hub_id, kul.id, team, m, assignment.starts, assignment.ends ?? null, assignment.revoked ?? null]);
    }
    return id;
  }
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const noAssign = await person('noassign');
  const future = await person('future', { assignment: { starts: iso(DAY) } });
  const farFuture = await person('farfuture', { assignment: { starts: iso(3650 * DAY) } });
  const expired = await person('expired', { assignment: { starts: iso(-5 * DAY), ends: iso(-DAY) } });
  const revoked = await person('revoked', { assignment: { starts: iso(-5 * DAY), revoked: iso(-1000) } });
  const pending = await person('pending', { status: 'pending', assignment: { starts: iso(-DAY) } });
  const active = await person('active', { assignment: { starts: iso(-DAY) } });

  // an own-station report (submitted by the active ASO) that none of the others may read
  await db.query('reset role;');
  const rep = nextId();
  await db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies)
    values ($1,$2,'submitted','KUL - MAA','ALPHA','TV active','S1',current_date,'10:00','AK703','ARR','x','A320','9M-AXA','10:00','10:05','B1','NO','sl','YES','YES','none');`, [rep, active]);
  await sup();
  await db.query('select pg_temp.sim_user($1)', [active]);
  await db.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [rep]);
  await sup();
  await db.query('select * from public.process_report_index_queue(100);');
  const repoId = (await one('select id from public.central_reports_index where source_id = $1;', [rep]))?.id;

  const probe = async (user, sql, params = []) => {
    await db.query('select pg_temp.sim_user($1)', [user]);
    await db.query('savepoint p');
    try {
      const r = await db.query(sql, params);
      await db.query('release savepoint p');
      const shape = r.rows.map((x) => JSON.stringify(x, (k, v) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) ? '<uuid>' : v)));
      return { ok: true, n: r.rowCount, shape: shape.sort().join('|') };
    } catch (e) {
      await db.query('rollback to savepoint p');
      return { ok: false, err: e.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>') };
    } finally { await sup(); }
  };
  const same = (a, b) => (a.ok === b.ok) && (a.ok ? a.n === b.n && a.shape === b.shape : a.err === b.err);

  // ---- 1. sanity: the control really is different from "no assignment"
  const ctl = await probe(active, 'select * from public.get_my_active_role_assignments();');
  const nul = await probe(noAssign, 'select * from public.get_my_active_role_assignments();');
  assert(ctl.n === 1 && nul.n === 0, 'control: active ASO has one active assignment, no-assignment profile has none');
  for (const [lbl, u] of [['future (+1 day)', future], ['future (+10 years)', farFuture], ['expired', expired], ['revoked', revoked], ['pending profile', pending]]) {
    const r = await probe(u, 'select * from public.get_my_active_role_assignments();');
    assert(r.ok && r.n === 0, `${lbl}: get_my_active_role_assignments() returns nothing`);
  }

  // ---- 2. role / scope helpers for every role code
  for (const code of roles.keys()) {
    const base = await probe(noAssign, 'select public.has_active_role($1) v;', [code]);
    for (const [lbl, u] of [['future', future], ['expired', expired], ['revoked', revoked], ['pending', pending]]) {
      const r = await probe(u, 'select public.has_active_role($1) v;', [code]);
      if (!same(base, r)) assert(false, `${lbl}: has_active_role('${code}') differs from a no-assignment profile`);
    }
  }
  assert(true, 'has_active_role() is identical to "no assignment" for future/expired/revoked/pending across every role code');
  const scope = 'select public.has_role_in_scope($1,$2,$3,$4,$5,$6,$7,$8) v;';
  for (const [lbl, u] of [['future', future], ['expired', expired], ['revoked', revoked], ['pending', pending]]) {
    const r = await probe(u, scope, ['aso', myAoc, null, opsDept, null, kul.hub_id, kul.id, team]);
    assert(r.ok && r.shape.includes('false'), `${lbl}: has_role_in_scope(aso, exact KUL team scope) is false`);
  }
  const ctlScope = await probe(active, scope, ['aso', myAoc, null, opsDept, null, kul.hub_id, kul.id, team]);
  assert(ctlScope.shape.includes('true'), 'control: active ASO has the same exact scope');

  // ---- 3. report access
  if (repoId) {
    for (const [lbl, u] of [['future', future], ['future (+10y)', farFuture], ['expired', expired], ['revoked', revoked], ['pending', pending], ['no assignment', noAssign]]) {
      const r = await probe(u, 'select public.has_report_access($1) v;', [repoId]);
      assert(r.ok && r.shape.includes('false'), `${lbl}: has_report_access(own-station report) is false`);
      const s = await probe(u, 'select * from public.search_reports_filtered_secure(1,10,null,null,null,null,null,null);');
      assert(!s.ok || s.n === 0, `${lbl}: filtered report search returns nothing`);
      const g = await probe(u, 'select * from public.get_report_by_source_secure($1,$2,null);', ['report_sec016', rep]);
      assert(!g.ok, `${lbl}: opening the report by source id is refused`);
    }
  }

  // ---- 4. differential sweep over every zero-argument, non-mutating function a client can call
  const fns = await rows(`select p.proname, p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.provolatile in ('s','i') and p.prorettype <> 'trigger'::regtype
      and (p.pronargs = 0 or p.pronargs = p.pronargdefaults)
      and has_function_privilege('authenticated', p.oid, 'execute') order by 1;`);
  let compared = 0;
  const leaks = [];
  for (const f of fns) {
    const sql = `select * from public.${f.proname}()`;
    const base = await probe(noAssign, sql);
    for (const [lbl, u] of [['future', future], ['future+10y', farFuture], ['expired', expired], ['revoked', revoked]]) {
      const r = await probe(u, sql);
      compared += 1;
      if (!same(base, r)) leaks.push(`${lbl}: ${f.proname}()`);
    }
  }
  console.log(`INFO: ${fns.length} zero-argument client-callable functions compared across 4 states (${compared} comparisons)`);
  assert(leaks.length === 0, `no zero-argument function treats a future/expired/revoked assignment differently from no assignment${leaks.length ? ' -- ' + leaks.join('; ') : ''}`);
  // the harness can see differences: at least one function distinguishes the active control
  let distinguished = 0;
  for (const f of fns.slice(0, 400)) {
    const sql = `select * from public.${f.proname}()`;
    const a = await probe(active, sql); const b = await probe(noAssign, sql);
    if (!same(a, b)) distinguished += 1;
  }
  assert(distinguished > 5, `control: ${distinguished} functions distinguish an active assignment from none (the sweep can detect a leak)`);

  // ---- 5. targeted surfaces that take arguments
  for (const [lbl, u] of [['future', future], ['expired', expired], ['revoked', revoked], ['pending', pending]]) {
    const ann = await probe(u, "select * from public.get_visible_announcements_secure(null, null, false);");
    const annBase = await probe(noAssign, "select * from public.get_visible_announcements_secure(null, null, false);");
    assert(same(ann, annBase), `${lbl}: visible announcements identical to no assignment`);
    const scan = await probe(u, "select public.can_user_scan_caterlink('KUL - MAA') v;");
    assert(scan.ok ? scan.shape.includes('false') : true, `${lbl}: CaterLink scan capability is false`);
    const wois = await probe(u, 'select public.is_wois_eligible_secure() v;');
    assert(wois.ok ? wois.shape.includes('false') : true, `${lbl}: WOIS eligibility is false`);
    const dir = await probe(u, 'select * from public.list_malaysia_staff_directory_secure(null,null,1,10);');
    assert(!dir.ok, `${lbl}: Malaysia directory refused`);
    const bay = await probe(u, 'select * from public.list_bay_board_scopes_secure();');
    assert(!bay.ok, `${lbl}: Bay Board scopes refused`);
  }

  // ---- 6. RLS: direct table reads
  for (const t of ['bay_board', 'duty_records', 'roster_entries']) {
    const exists = await one(`select to_regclass('public.${t}') r;`);
    if (!exists.r) continue;
    const base = await probe(noAssign, `select count(*)::int c from public.${t};`);
    for (const [lbl, u] of [['future', future], ['expired', expired], ['revoked', revoked]]) {
      const r = await probe(u, `select count(*)::int c from public.${t};`);
      assert(same(base, r), `${lbl}: direct read of ${t} identical to no assignment`);
    }
  }

  await db.query('rollback;');
  await db.end();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
