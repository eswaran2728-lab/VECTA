// Role-workspace support (migration 20261102000001): explicit stored entity authority, Bay Board oversight read path, the Global
// Reporting Controller workspace, and request gating for future/expired/revoked/pending callers. Native PostgreSQL only.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log('FAIL:', msg); } else { passes += 1; console.log('PASS:', msg); } };

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_role_workspace_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Role-workspace support verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    begin perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false); perform set_config('role', 'service_role', false); end; $$;`);
  const sup = () => db.query('select pg_temp.sim_service();');
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  await db.query('begin;');
  await sup();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const dept = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
  const opsDept = await dept('operation');
  const enfDept = await dept('enforcement');
  const roles = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [kul.id]);
  const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [kul.id])).id;
  let seq = 0x8100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  async function person(label, role, { status = 'approved', starts = iso(-DAY), ends = null, revoked = null } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `rw-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `rw-${label}@example.test`, `RW ${label}`, `RW-${label}`.slice(0, 20), status]);
    if (role === 'grc') {
      await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5);', [id, roles.get('global_reporting_controller'), starts, ends, revoked]);
    } else if (role === 'ghod') {
      await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5);', [id, roles.get('ghod'), starts, ends, revoked]);
    } else if (role === 'operation_manager') {
      await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7);', [id, roles.get(role), myAoc, opsDept, starts, ends, revoked]);
    } else if (role === 'main_enforcement') {
      await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7);', [id, roles.get(role), myAoc, enfDept, starts, ends, revoked]);
    } else if (role === 'aso') {
      const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
      await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);', [id, roles.get('aso'), myAoc, opsDept, kul.hub_id, kul.id, team, m, starts, ends, revoked]);
    }
    return id;
  }
  const denied = async (u, sql, p = []) => {
    await db.query('select pg_temp.sim_user($1)', [u]);
    await db.query('savepoint d');
    try { await db.query(sql, p); await db.query('rollback to savepoint d'); return null; }
    catch (e) { await db.query('rollback to savepoint d'); return e.message; }
    finally { await sup(); }
  };
  const asUser = async (u, sql, p = []) => { await db.query('select pg_temp.sim_user($1)', [u]); try { return await rows(sql, p); } finally { await sup(); } };

  const grc = await person('grc', 'grc');
  const ghod = await person('ghod', 'ghod');
  const opm = await person('opm', 'operation_manager');
  const enf = await person('enf', 'main_enforcement');
  const aso = await person('aso', 'aso');
  const futureAso = await person('futureaso', 'aso', { starts: iso(DAY) });
  const expiredAso = await person('expiredaso', 'aso', { starts: iso(-5 * DAY), ends: iso(-DAY) });
  const revokedAso = await person('revokedaso', 'aso', { revoked: iso(-1000) });
  const pendingAso = await person('pendingaso', 'aso', { status: 'pending' });
  const futureGhod = await person('futureghod', 'ghod', { starts: iso(DAY) });
  const futureGrc = await person('futuregrc', 'grc', { starts: iso(DAY) });

  // ---- A. explicit stored entity is authoritative (trusted insert), the prefix only proposes
  const mk = async (flight, explicitEntity, explicitCode, who = aso) => {
    const id = nextId();
    await db.query('reset role;');
    await db.query('select set_config($1, $2, false)', ['request.jwt.claims', explicitEntity ? JSON.stringify({ role: 'service_role' }) : '{}']);
    if (explicitEntity) await db.query("select set_config('role', 'service_role', false)");
    await db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies, operating_entity_id, operating_entity_code)
      values ($1,$2,'submitted','KUL - MAA','ALPHA','RW','S1',current_date,'10:00',$3,'ARR','x','A320','9M-AXA','10:00','10:05','B1','NO','sl','YES','YES','none',$4,$5);`, [id, who, flight, explicitEntity, explicitCode]);
    await sup();
    return (await one('select operating_entity_code c from public.report_sec016 where id = $1;', [id])).c;
  };
  assert(await mk('AK703', null, null) === 'MAA', 'no stored value: AK703 PROPOSES and receives MAA');
  assert(await mk('D7 123', null, null) === 'AAX', 'no stored value: D7 123 PROPOSES and receives AAX');
  assert(await mk('AK703', aax, 'AAX') === 'AAX', 'explicit stored AAX is NOT overridden by an AK prefix');
  assert(await mk('D7 123', maa, 'MAA') === 'MAA', 'explicit stored MAA is NOT overridden by a D7 prefix');
  assert(await mk('AK703/D7123', aax, 'AAX') === 'AAX', 'explicit stored entity survives a conflicting flight value');
  assert(await mk('AK703/D7123', null, null) === null, 'no stored value + conflicting flight stays unclassified (never guessed)');

  // ---- B. Bay Board oversight read path
  for (const [lbl, u] of [['Operation Manager', opm], ['Main Enforcement', enf]]) {
    const scopes = await asUser(u, 'select * from public.list_bay_board_scopes_secure();');
    assert(scopes.length > 0, `${lbl}: Bay Board hub/station selectors available`);
    assert(Array.isArray(await asUser(u, 'select * from public.get_bay_board_secure(null, null);')), `${lbl}: Bay Board rows readable`);
  }
  for (const [lbl, u] of [['ASO', aso], ['GHOD', ghod], ['GRC', grc], ['future-dated ASO', futureAso], ['expired ASO', expiredAso], ['revoked ASO', revokedAso], ['pending ASO', pendingAso]]) {
    assert(await denied(u, 'select * from public.list_bay_board_scopes_secure();') !== null, `${lbl}: Bay Board selector RPC refused`);
    assert(await denied(u, 'select * from public.get_bay_board_secure(null, null);') !== null, `${lbl}: Bay Board read RPC refused`);
  }

  // ---- C. GRC workspace
  // a repository report to request access to
  const rep = nextId();
  await db.query('reset role;');
  await db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies)
    values ($1,$2,'submitted','KUL - MAA','ALPHA','RW','S1',current_date,'10:00','AK703','ARR','x','A320','9M-AXA','10:00','10:05','B1','NO','sl','YES','YES','none');`, [rep, aso]);
  await sup();
  await db.query('select pg_temp.sim_user($1)', [aso]);
  await db.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [rep]);
  await sup();
  await db.query('select * from public.process_report_index_queue(50);');
  const repoId = (await one('select id from public.central_reports_index where source_id = $1;', [rep])).id;

  const reqId = (await asUser(ghod, 'select public.request_report_access($1, $2, 7) id;', [repoId, 'executive review of a flagged incident']))[0].id;
  assert(!!reqId, 'GHOD (active) can open a report-access request');
  for (const [lbl, u] of [['future-dated GHOD', futureGhod], ['future-dated ASO', futureAso], ['expired ASO', expiredAso], ['revoked ASO', revokedAso], ['pending ASO', pendingAso]]) {
    assert(await denied(u, 'select public.request_report_access($1, $2, 7);', [repoId, 'probe']) !== null, `${lbl}: cannot open a report-access request`);
  }
  const q = await asUser(grc, "select * from public.list_report_access_requests_secure('pending', 1, 25);");
  assert(q.length === 1 && q[0].id === reqId && q[0].status === 'pending' && Number(q[0].total_count) === 1, 'GRC sees the pending request with identifiers only');
  assert(!('content' in q[0]) && !('body' in q[0]), 'request queue carries no report content');
  for (const [lbl, u] of [['GHOD', ghod], ['ASO', aso], ['Operation Manager', opm], ['future-dated GRC', futureGrc]]) {
    assert(await denied(u, "select * from public.list_report_access_requests_secure(null, 1, 25);") !== null, `${lbl}: report-request queue refused`);
    assert(await denied(u, "select * from public.list_report_access_grants_secure(null, 1, 25);") !== null, `${lbl}: grants history refused`);
    assert(await denied(u, "select * from public.list_report_access_audit_secure('export', 1, 25);") !== null, `${lbl}: access/export audit refused`);
    assert(await denied(u, "select public.reject_report_access_request($1, 'no');", [reqId]) !== null, `${lbl}: cannot reject a request`);
  }
  const grantId = (await asUser(grc, "select public.grant_report_access($1, $2, 'approved for review', now() + interval '3 days') g;", [reqId, ghod]))[0].g;
  assert(!!grantId, 'GRC approves the request with an expiry');
  const grants = await asUser(grc, "select * from public.list_report_access_grants_secure('active', 1, 25);");
  assert(grants.length === 1 && grants[0].state === 'active' && grants[0].expires_at !== null, 'grant history lists the active grant with its expiry');
  await db.query("update public.report_access_grants set expires_at = now() - interval '1 minute', starts_at = now() - interval '2 days' where id = $1;", [grantId]);
  const expired = await asUser(grc, "select * from public.list_report_access_grants_secure('expired', 1, 25);");
  assert(expired.length === 1 && expired[0].state === 'expired', 'an expired grant is shown as expired');
  assert((await asUser(ghod, 'select public.has_report_access($1) v;', [repoId]))[0].v === false, 'an expired grant no longer gives GHOD report access');
  const reqId2 = (await asUser(ghod, 'select public.request_report_access($1, $2, 1) id;', [repoId, 'second request']))[0].id;
  await asUser(grc, "select public.reject_report_access_request($1, 'not required for the stated purpose');", [reqId2]);
  const rej = await asUser(grc, "select * from public.list_report_access_requests_secure('rejected', 1, 25);");
  assert(rej.length === 1 && rej[0].decision_reason.length > 3, 'GRC rejects a request with a recorded reason');
  assert(await denied(grc, "select public.reject_report_access_request($1, 'again');", [reqId2]) !== null, 'a reviewed request cannot be rejected twice');
  const aud = await asUser(grc, "select * from public.list_report_access_audit_secure('grants', 1, 50);");
  const acts = new Set(aud.map((a) => a.action));
  assert(acts.has('access_request') && acts.has('grant') && acts.has('access_request_rejected'), 'access audit records request, grant and rejection');
  assert(await denied(grc, "select * from public.list_report_access_audit_secure('everything', 1, 25);") !== null, 'unknown audit scope refused');

  await db.query('rollback;');
  await db.end();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
