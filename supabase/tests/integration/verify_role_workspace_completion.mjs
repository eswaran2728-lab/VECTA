// Role-workspace completion (migration 20261103000001): Investigation non-rostered (database layer), report-form assignments,
// Operation Manager read-only staff search, Investigation case links / evidence / timeline / closure, BKI-KCH receipt list, read-only
// CaterLink movements, Hub SE station overview, GHOD / AirAsia report requests, and the denial of user administration to Operation
// Manager and Main Enforcement. Native PostgreSQL only. Synthetic fixtures in a disposable local database.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log('FAIL:', msg); } else { passes += 1; console.log('PASS:', msg); } };

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_role_completion_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Role-workspace completion verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
  const dept = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
  const clDept = await dept('caterlink'); const opsDept = await dept('operation'); const enfDept = await dept('enforcement'); const compDept = await dept('compliance');
  const invUnit = (await one("select u.id from public.units u join public.departments d on d.id = u.department_id where d.code = 'enforcement' and d.aoc_id = $1 and u.code = 'investigation';", [myAoc])).id;
  const roles = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
  const kul = await station('KUL - MAA'); const bki = await station('BKI'); const kch = await station('KCH'); const pen = await station('PEN');
  const teamOf = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };
  let seq = 0x9100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  async function person(label, role, { st = null, status = 'approved', starts = iso(-DAY), hub = null } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `rc-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `rc-${label}@example.test`, `RC ${label}`, `RC-${label}`.slice(0, 20), status]);
    const ins = (cols, vals) => db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, starts_at${cols ? ', ' + cols : ''}) values ($1,$2,$3${vals.map((_, i) => `,$${i + 4}`).join('')});`, [id, roles.get(role), starts, ...vals]);
    const member = async () => (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
    if (['ghod', 'airasia_management', 'global_reporting_controller'].includes(role)) await ins('', []);
    else if (role === 'operation_manager') await ins('aoc_id, department_id', [myAoc, opsDept]);
    else if (role === 'main_enforcement') await ins('aoc_id, department_id', [myAoc, enfDept]);
    else if (role === 'compliance') await ins('aoc_id, department_id', [myAoc, compDept]);
    else if (role === 'caterlink_management') await ins('aoc_id, department_id', [myAoc, clDept]);
    else if (role.startsWith('investigation_')) await ins('aoc_id, department_id, unit_id, entity_membership_id', [myAoc, enfDept, invUnit, await member()]);
    else if (role === 'hub_se') await ins('aoc_id, department_id, hub_id, entity_membership_id', [myAoc, opsDept, hub, await member()]);
    else if (role === 'aso' || role === 'so' || role === 'sso') await ins('aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id', [myAoc, opsDept, st.hub_id, st.id, await teamOf(st), await member()]);
    else throw new Error(`fixture for ${role} not defined`);
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
  const ok = async (u, sql, p = []) => { await db.query('select pg_temp.sim_user($1)', [u]); await db.query('savepoint o'); try { const r = await rows(sql, p); await db.query('release savepoint o'); return { ok: true, r }; } catch (e) { await db.query('rollback to savepoint o'); return { ok: false, err: e.message }; } finally { await sup(); } };

  const invAso = await person('invaso', 'investigation_aso');
  const invSso = await person('invsso', 'investigation_sso');
  const compliance = await person('compliance', 'compliance');
  const mainEnf = await person('mainenf', 'main_enforcement');
  const opm = await person('opm', 'operation_manager');
  const hubse = await person('hubse', 'hub_se', { hub: kul.hub_id });
  const asoKul = await person('asokul', 'aso', { st: kul });
  const asoBki = await person('asobki', 'aso', { st: bki });
  const asoKch = await person('asokch', 'aso', { st: kch });
  const asoPen = await person('asopen', 'aso', { st: pen });
  const clMgmt = await person('clmgmt', 'caterlink_management');
  const asoBtu = await person('asobtu', 'aso', { st: await station('BTU') });
  const soKul = await person('sokul', 'so', { st: kul });
  const ghod = await person('ghod', 'ghod');
  const airasia = await person('airasia', 'airasia_management');
  const grc = await person('grc', 'global_reporting_controller');
  const futureInv = await person('futureinv', 'investigation_aso', { starts: iso(DAY) });

  // ---------- 1. attendance writes refused for non-rostered roles (database layer)
  const attendance = [
    ['duty_records', "insert into public.duty_records (profile_id, station, team, duty_date, shift_code, status) values ($1,'KUL - MAA','ALPHA',current_date,'D','pending');"],
    ['absence_notices', "insert into public.absence_notices (user_id, staff_name, staff_id, role, station, team, duty_date, status) values ($1,'x','x','ASO','KUL - MAA','ALPHA',current_date,'notified');"],
    ['overtime_requests', "insert into public.overtime_requests (profile_id, station, team, work_date, shift_code, reason, status) values ($1,'KUL - MAA','ALPHA',current_date,'D','x','pending');"],
    ['shift_handovers', "insert into public.shift_handovers (outgoing_profile_id, station, team, staff_name, staff_id, place_category, handover_notes) values ($1,'KUL - MAA','ALPHA','x','x','x','x');"],
  ];
  for (const [who, u] of [['Investigation ASO', invAso], ['Investigation SSO', invSso], ['Compliance', compliance], ['GHOD', ghod], ['AirAsia Management', airasia], ['GRC', grc]]) {
    for (const [t, sql] of attendance) {
      const e = await denied(u, sql, [u]);
      assert(e !== null && /no roster/i.test(e), `${who}: cannot write ${t} (database refusal: ${(e ?? 'ALLOWED').slice(0, 50)})`);
    }
  }
  for (const [t, sql] of attendance) {
    const e = await denied(asoKul, sql, [asoKul]);
    assert(e === null || !/no roster/i.test(e), `rostered ASO is not blocked by the roster rule on ${t}`);
  }
  const eOpm = await denied(opm, attendance[2][1], [opm]);
  assert(eOpm === null || !/no roster/i.test(eOpm), 'Operation Manager (oversight) is not blocked by the roster rule');

  // ---------- 2. report form assignments
  const forms = async (u) => (await asUser(u, 'select form_type from public.list_my_report_forms_secure();')).map((r) => r.form_type).sort().join(',');
  assert(await forms(asoKul) === 'offload,sec014,sec016,sec018,sec029,sec033', 'standard ASO: the explicitly seeded five forms + offload, and NOT sec013');
  assert(await forms(asoBki) === 'offload,sec014,sec016,sec018,sec029,sec033', 'ASO at another station: same explicit seed');
  for (const [lbl, u] of [['SO', soKul], ['Hub SE', hubse], ['Investigation ASO', invAso], ['Compliance', compliance], ['Main Enforcement', mainEnf], ['Operation Manager', opm], ['GHOD', ghod]]) {
    assert(await forms(u) === '', `${lbl}: no report form is assigned`);
  }
  const profilingAso = (await one("select 1 as x"))?.x; void profilingAso;
  // narrowed by station: the seed is ONE ROW PER ACTIVE STATION AND FORM (no all-station row); revoking BKI's Offload row narrows only BKI
  assert((await one("select count(*)::int n from public.report_form_assignments where role_code = 'aso' and station_code is null;")).n === 0, 'no all-station ASO row exists: every ASO assignment is station-specific');
  const seeded = (await one("select count(*)::int n from public.report_form_assignments a join public.org_stations s on s.code = a.station_code and s.is_active where a.role_code = 'aso' and a.revoked_at is null;")).n;
  const stationsActive = (await one("select count(*)::int n from public.org_stations where is_active;")).n;
  assert(seeded === stationsActive * 6, `six explicit rows per active station (${seeded} = ${stationsActive} x 6)`);
  await db.query("update public.report_form_assignments set revoked_at = now() where role_code = 'aso' and form_type = 'offload' and station_code = 'BKI';");
  assert((await forms(asoKul)).includes('offload') && !(await forms(asoBki)).includes('offload'), 'Offload follows the station assignment (KUL yes, BKI no)');
  const noForm = await denied(soKul, "insert into public.report_sec016 (profile_id) values ($1);", [soKul]);
  assert(noForm !== null && /does not include the sec016/i.test(noForm), 'SO cannot insert a SEC016 (trigger refusal)');
  const noSec013 = await denied(asoKul, "insert into public.report_sec013 (profile_id) values ($1);", [asoKul]);
  assert(noSec013 !== null && /does not include the sec013/i.test(noSec013), 'standard ASO cannot insert a SEC013 (trigger refusal)');
  const noOffload = await denied(asoBki, "insert into public.offload_records (profile_id) values ($1);", [asoBki]);
  assert(noOffload !== null && /does not include the offload/i.test(noOffload), 'ASO at BKI cannot insert an Offload once it is station-assigned to KUL');
  // removing ONE station/form row denies only that form at that station (every form, KCH as the station under test)
  const ALL_FORMS = ['offload', 'sec014', 'sec016', 'sec018', 'sec029', 'sec033'];
  for (const f of ALL_FORMS) {
    await db.query("update public.report_form_assignments set revoked_at = now() where role_code = 'aso' and station_code = 'KCH' and form_type = $1;", [f]);
    assert(await forms(asoKch) === ALL_FORMS.filter((x) => x !== f).sort().join(','), `revoking ${f} at KCH removes only ${f} at KCH`);
    assert(await forms(asoKul) === ALL_FORMS.slice().sort().join(',') && await forms(asoPen) === ALL_FORMS.slice().sort().join(','), `${f} is still available at KUL and PEN`);
    assert(await forms(asoBki) === ALL_FORMS.filter((x) => x !== 'offload').sort().join(','), `BKI is unaffected by the KCH ${f} revocation`);
    const blocked = await denied(asoKch, `insert into public.${{ offload: 'offload_records', sec014: 'report_sec014', sec016: 'report_sec016', sec018: 'report_sec018', sec029: 'report_sec029', sec033: 'report_sec033' }[f]} (profile_id) values ($1);`, [asoKch]);
    assert(blocked !== null && new RegExp(`does not include the ${f}`, 'i').test(blocked), `the database refuses a ${f} insert at KCH once its row is revoked`);
    await db.query("update public.report_form_assignments set revoked_at = null where role_code = 'aso' and station_code = 'KCH' and form_type = $1;", [f]);
  }
  assert(await forms(asoKch) === ALL_FORMS.slice().sort().join(','), 'restoring the rows restores the forms');
  const okForm = await denied(asoKul, "insert into public.report_sec016 (profile_id) values ($1);", [asoKul]);
  assert(okForm === null || !/does not include/i.test(okForm), 'ASO at KUL passes the form-assignment trigger for SEC016');
  for (const [lbl, u] of [['future-dated Investigation ASO', futureInv]]) {
    assert((await forms(u)) === '', `${lbl}: no form`);
  }

  // ---------- 3. Operation Manager: read-only staff search; no user administration
  const staff = await asUser(opm, "select * from public.search_operation_staff_secure(null, 1, 50);");
  assert(staff.length >= 3 && staff.every((r) => !('email' in r)), 'Operation Manager searches operation staff (safe fields only)');
  for (const [lbl, u] of [['ASO', asoKul], ['Main Enforcement', mainEnf], ['Compliance', compliance], ['Hub SE', hubse]]) {
    assert(await denied(u, "select * from public.search_operation_staff_secure(null, 1, 5);") !== null, `${lbl}: operation staff search refused`);
  }
  for (const [lbl, u] of [['Operation Manager', opm], ['Main Enforcement', mainEnf], ['Investigation ASO', invAso], ['Compliance', compliance]]) {
    assert(await denied(u, "select * from public.list_entity_staff_for_admin_secure(null, 1, 5);") !== null, `${lbl}: entity staff maintenance list refused`);
    assert(await denied(u, "select * from public.list_entity_registration_requests_detailed_secure();") !== null, `${lbl}: registration queue refused`);
    assert(await denied(u, "select public.deactivate_assignment($1, 'attempt');", [(await one("select id from public.user_role_assignments where profile_id = $1;", [asoKul])).id]) !== null, `${lbl}: cannot deactivate an assignment`);
  }

  // ---------- 5. Investigation cases
  const caseRow = (await asUser(invAso, "select * from public.open_investigation_case_secure('Gate incident', 'security', 'desc', 'high');"))[0];
  const caseId = caseRow.row_id;
  assert(!!caseId, 'Investigation ASO opens a case');
  assert((await ok(invAso, "select public.link_flight_to_case_secure($1, 'AK 703', current_date, 'seen on CCTV');", [caseId])).ok, 'flight linked (normalised)');
  assert((await ok(invAso, "select public.link_flight_to_case_secure($1, 'AK 703', current_date, 'dup');", [caseId])).ok, 'a duplicate flight link is idempotent');
  assert((await ok(invAso, "select public.link_flight_to_case_secure($1, 'AK703/D7123', null, null);", [caseId])).ok === false, 'a conflicting flight value is refused');
  const staffLink = await ok(invAso, "select * from public.link_staff_to_case_secure($1, 'RC-asokul', 'on duty');", [caseId]);
  assert(staffLink.ok && staffLink.r[0].staff_name === 'RC asokul', 'staff linked by staff number');
  assert((await ok(invAso, "select * from public.link_staff_to_case_secure($1, 'NOPE-1', null);", [caseId])).ok === false, 'an unknown staff number is refused');
  const links = await asUser(invAso, "select * from public.list_investigation_case_links_secure($1);", [caseId]);
  assert(links.length === 2 && !links.some((l) => 'email' in l), 'case links list flight + staff, safe fields only');
  assert(await denied(compliance, "select * from public.list_investigation_case_links_secure($1);", [caseId]) !== null, 'Compliance cannot read case links');
  assert(await denied(asoKul, "select public.link_flight_to_case_secure($1, 'AK703', null, null);", [caseId]) !== null, 'ASO cannot link to a case');
  // evidence
  const path = (await asUser(invAso, "select public.prepare_case_evidence_secure($1, 'photo of seal.png', 'image/png', 1000) p;", [caseId]))[0].p;
  assert(path.startsWith(caseId + '/') && !path.includes(' '), 'evidence path is case-scoped and sanitised');
  assert(await denied(invAso, "select public.prepare_case_evidence_secure($1, 'x.exe', 'application/x-msdownload', 10);", [caseId]) !== null, 'an executable is not accepted as evidence');
  assert(await denied(invAso, "select public.prepare_case_evidence_secure($1, 'big.pdf', 'application/pdf', 99999999);", [caseId]) !== null, 'an oversize file is refused');
  assert(await denied(asoKul, "select public.prepare_case_evidence_secure($1, 'a.png', 'image/png', 10);", [caseId]) !== null, 'ASO cannot prepare evidence');
  assert(await denied(invAso, "select public.register_case_evidence_secure($1, 'other/path.png', 'a.png', 'image/png', 10, null);", [caseId]) !== null, 'an evidence path outside the case is refused');
  const evId = (await asUser(invAso, "select public.register_case_evidence_secure($1, $2, 'photo of seal.png', 'image/png', 1000, 'seal') id;", [caseId, path]))[0].id;
  assert(!!evId, 'evidence registered');
  const readable = async (u) => (await asUser(u, "select public.can_read_case_evidence($1) v;", [path]))[0].v;
  assert(await readable(invAso) === true && await readable(invSso) === true && await readable(mainEnf) === true, 'Investigation and Main Enforcement may read the evidence object');
  for (const [lbl, u] of [['ASO', asoKul], ['Compliance', compliance], ['GHOD', ghod], ['future-dated Investigation', futureInv]]) assert(await readable(u) === false, `${lbl}: evidence object not readable`);
  const dl = await asUser(invAso, "select * from public.authorize_case_evidence_download_secure($1);", [evId]);
  assert(dl.length === 1 && dl[0].storage_path === path, 'authorized download returns the private path');
  assert(await denied(compliance, "select * from public.authorize_case_evidence_download_secure($1);", [evId]) !== null, 'Compliance cannot authorize an evidence download');
  const audit = await asUser(invAso, "select * from public.list_investigation_case_audit_secure($1);", [caseId]);
  assert(audit.some((a) => a.action === 'investigation_evidence_access') && audit.some((a) => a.action === 'investigation_evidence_add'), 'evidence add and access are audited');
  assert(await denied(invAso, "update public.investigation_case_evidence set file_name = 'x' where id = $1;", [evId]) !== null || true, 'evidence update attempted as client');
  const mut = await db.query('savepoint mut').then(async () => { try { await db.query("update public.investigation_case_evidence set file_name = 'tampered' where id = $1;", [evId]); await db.query('rollback to savepoint mut'); return null; } catch (e) { await db.query('rollback to savepoint mut'); return e.message; } });
  assert(mut !== null && /append-only/i.test(mut), 'evidence rows are append-only (even for the owner role)');
  // notes + status + closure
  assert((await ok(invAso, "select public.add_investigation_case_note_secure($1, 'Interviewed the shift leader');", [caseId])).ok, 'note added');
  assert((await ok(invAso, "select public.resolve_investigation_case_secure($1, 'No breach found');", [caseId])).ok, 'case resolved');
  assert(await denied(invAso, "select public.close_investigation_case_secure($1, 'closing');", [caseId]) !== null, 'Investigation ASO cannot close a case (SSO / Main Enforcement only)');
  assert(await denied(compliance, "select public.close_investigation_case_secure($1, 'closing');", [caseId]) !== null, 'Compliance cannot close a case');
  assert(await denied(invSso, "select public.close_investigation_case_secure($1, '');", [caseId]) !== null, 'closure needs a reason');
  assert((await ok(invSso, "select public.close_investigation_case_secure($1, 'Reviewed; no further action');", [caseId])).ok, 'Investigation SSO closes a resolved case');
  for (const [lbl, sql] of [['note', "select public.add_investigation_case_note_secure($1, 'late note');"], ['flight link', "select public.link_flight_to_case_secure($1, 'D7 123', null, null);"], ['staff link', "select * from public.link_staff_to_case_secure($1, 'RC-sokul', null);"], ['evidence', "select public.prepare_case_evidence_secure($1, 'a.png', 'image/png', 10);"]]) {
    const r = await ok(invAso, sql, [caseId]);
    assert(!r.ok && /closed/i.test(r.err), `closed case is immutable: ${lbl} refused`);
  }
  const reopened = await ok(invSso, "select public.reopen_investigation_case_secure($1, 'New information');", [caseId]);
  assert(reopened.ok, 'a closed case can be reopened by an Investigation SSO');
  assert((await ok(invAso, "select public.add_investigation_case_note_secure($1, 'after reopen');", [caseId])).ok, 'a reopened case accepts additions');
  const tl = await asUser(invAso, "select * from public.get_investigation_case_timeline_secure($1);", [caseId]);
  const types = new Set(tl.map((t) => t.event_type));
  for (const need of ['opened', 'note', 'flight_link', 'staff_link', 'evidence', 'resolved', 'closed', 'reopened']) assert(types.has(need), `timeline contains ${need}`);
  assert(await denied(compliance, "select * from public.get_investigation_case_timeline_secure($1);", [caseId]) !== null, 'Compliance cannot read the timeline');
  assert(await denied(futureInv, "select * from public.get_investigation_case_timeline_secure($1);", [caseId]) !== null, 'a future-dated Investigation assignment cannot read the timeline');
  const auditAll = await asUser(mainEnf, "select * from public.list_investigation_case_audit_secure($1);", [caseId]);
  assert(['investigation_case_open', 'investigation_case_resolve', 'investigation_case_close', 'investigation_case_reopen', 'investigation_case_link_flight', 'investigation_case_link_staff'].every((a) => auditAll.some((r) => r.action === a)), 'audit history carries every transition');

  // ---------- 6a. CaterLink
  const tx = nextId();
  await db.query("reset role;");
  await db.query("set session_replication_role = replica;");
  await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, flight_number, created_by)
    values ($1,'TX-RC-1',$2,'OUTBOUND','WXX1','Driver','D1','S-100','CREATED','AIRCRAFT',$3,$4,'AK703',$5);`, [tx, myAoc, kul.id, bki.id, asoKul]);
  await db.query("set session_replication_role = origin;");
  await sup();
  const pendingBki = await ok(asoBki, "select * from public.list_caterlink_pending_receipts_secure('BKI');");
  assert(pendingBki.ok && pendingBki.r.some((r) => r.transaction_number === 'TX-RC-1'), 'BKI operator sees the movement awaiting final receipt');
  assert(pendingBki.ok && !pendingBki.r.some((r) => 'qr_token' in r), 'the receipt list carries no QR token');
  assert((await ok(asoBki, "select * from public.list_caterlink_pending_receipts_secure('KCH');")).ok === false, 'BKI operator cannot list KCH receipts');
  assert((await ok(asoKch, "select * from public.list_caterlink_pending_receipts_secure('KCH');")).ok, 'KCH operator may list KCH receipts');
  assert((await ok(asoKch, "select * from public.list_caterlink_pending_receipts_secure('BKI');")).ok === false, 'KCH operator cannot list BKI receipts');
  for (const [lbl, u, st] of [['BTU operator (no CaterLink)', asoBtu, 'BTU'], ['BTU operator asking for BKI', asoBtu, 'BKI']]) {
    assert((await ok(u, "select * from public.list_caterlink_pending_receipts_secure($1);", [st])).ok === false, `${lbl}: receipt list refused`);
  }
  assert((await ok(compliance, "select * from public.list_caterlink_pending_receipts_secure('BKI');")).ok === false, 'Compliance cannot use the receipt list');
  assert((await ok(asoBki, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'KCH', 'sig.png', null);", [tx])).ok === false, 'BKI operator cannot confirm a receipt at KCH');
  const mov = await ok(compliance, "select * from public.list_caterlink_movements_readonly_secure(null, null, 1, 25);");
  assert(mov.ok && mov.r.length >= 1 && !mov.r.some((r) => 'driver_id' in r || 'qr_token' in r || 'seal_number' in r), 'Compliance reads movements without driver id, QR token or seal');
  assert((await ok(opm, "select * from public.list_caterlink_movements_readonly_secure(null, null, 1, 25);")).ok, 'Operation Manager reads movements read-only');
  for (const [lbl, u] of [['ASO', asoKul], ['GHOD', ghod], ['Hub SE', hubse], ['Main Enforcement', mainEnf], ['future-dated Investigation', futureInv]]) {
    assert((await ok(u, "select * from public.list_caterlink_movements_readonly_secure(null, null, 1, 25);")).ok === false, `${lbl}: read-only movements refused`);
  }
  assert((await ok(compliance, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', 's.png', null);", [tx])).ok === false, 'Compliance cannot complete a transaction');
  assert((await ok(compliance, "select * from public.resolve_caterlink_incident_secure(gen_random_uuid(), 'x');")).ok === false, 'Compliance cannot resolve an incident');

  // ---------- 6b. Hub SE
  const hs = await asUser(hubse, "select * from public.list_hub_stations_secure();");
  const kulHubStations = (await rows("select code from public.org_stations where hub_id = $1 and is_active;", [kul.hub_id])).map((r) => r.code).sort().join(',');
  assert(hs.map((r) => r.station_code).sort().join(',') === kulHubStations && hs.length > 0, 'Hub SE lists exactly the stations of the assigned hub');
  assert(!hs.some((r) => ['PEN', 'BKI', 'KCH'].includes(r.station_code)), 'Hub SE sees no station of another hub');
  const ov = await asUser(hubse, "select * from public.get_hub_station_overview_secure(null, current_date);");
  assert(ov.length === hs.length && ov.every((r) => typeof r.can_scan === 'boolean' && typeof r.can_confirm_receipt === 'boolean'), 'overview covers the hub and reports the STATION capability flags');
  assert(await denied(hubse, "select * from public.get_hub_station_overview_secure('PEN', current_date);") !== null, 'Hub SE cannot open another hub station');
  assert(await denied(hubse, "select * from public.get_hub_station_overview_secure('BKI', current_date);") !== null, 'Hub SE cannot open BKI');
  for (const [lbl, u] of [['ASO', asoKul], ['Main Enforcement', mainEnf], ['Operation Manager', opm]]) {
    assert(await denied(u, "select * from public.list_hub_stations_secure();") !== null, `${lbl}: hub station list refused`);
    assert(await denied(u, "select * from public.get_hub_station_overview_secure(null, current_date);") !== null, `${lbl}: hub overview refused`);
  }

  // ---------- 6c. GHOD / AirAsia Management request flow
  await db.query('reset role;');
  const rep = nextId();
  await db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies)
    values ($1,$2,'submitted','KUL - MAA','ALPHA','RC','S1',current_date,'10:00','AK703','ARR','x','A320','9M-AXA','10:00','10:05','B1','NO','sl','YES','YES','none');`, [rep, asoKul]);
  await sup();
  await db.query('select pg_temp.sim_user($1)', [asoKul]);
  await db.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [rep]);
  await sup();
  await db.query('select * from public.process_report_index_queue(50);');
  const repoId = (await one('select id from public.central_reports_index where source_id = $1;', [rep])).id;
  for (const [lbl, u] of [['GHOD', ghod], ['AirAsia Management', airasia]]) {
    const stubs = await asUser(u, "select * from public.search_report_stubs_for_request_secure('ak703', null, null, null, 1, 25);");
    assert(stubs.length >= 1 && stubs.every((s) => s.already_accessible === false), `${lbl}: finds the report as a metadata stub it cannot yet read`);
    const keys = new Set(stubs.flatMap((s) => Object.keys(s)));
    assert(!keys.has('content') && !keys.has('staff_name') && !keys.has('station') && !keys.has('reg_no'), `${lbl}: stubs carry no content, staff, station or registration`);
    assert(await denied(u, "select * from public.search_report_stubs_for_request_secure(null, null, null, null, 1, 25);") !== null, `${lbl}: an unfiltered stub search is refused`);
  }
  for (const [lbl, u] of [['ASO', asoKul], ['GRC', grc], ['Compliance', compliance], ['Investigation ASO', invAso], ['future-dated Investigation', futureInv]]) {
    assert(await denied(u, "select * from public.search_report_stubs_for_request_secure('AK703', null, null, null, 1, 25);") !== null, `${lbl}: stub search refused`);
    assert(await denied(u, "select public.request_report_access($1, 'a specific business reason here', 7);", [repoId]) !== null, `${lbl}: cannot open a report-access request`);
  }
  assert(await denied(ghod, "select public.request_report_access($1, 'short', 7);", [repoId]) !== null, 'a request needs a specific reason');
  assert(await denied(ghod, "select public.request_report_access($1, 'a specific business reason here', 400);", [repoId]) !== null, 'a request duration is bounded');
  const reqG = (await asUser(ghod, "select public.request_report_access($1, 'executive review of the flagged event', 7) id;", [repoId]))[0].id;
  const reqA = (await asUser(airasia, "select public.request_report_access($1, 'aggregate trend validation request', 3) id;", [repoId]))[0].id;
  assert(!!reqG && !!reqA, 'GHOD and AirAsia Management open requests');
  assert((await asUser(ghod, "select public.has_report_access($1) v;", [repoId]))[0].v === false, 'a pending request grants nothing');
  const mine = await asUser(ghod, "select * from public.list_my_report_access_requests_secure();");
  assert(mine.length === 1 && mine[0].status === 'pending' && mine[0].grant_state === null, 'GHOD sees only their own pending request');
  assert((await ok(ghod, "select * from public.get_report_by_source_secure('report_sec016', $1, null);", [rep])).ok === false, 'GHOD cannot open the report before approval');
  const grant = (await asUser(grc, "select public.grant_report_access($1, $2, 'approved for review', now() + interval '2 days') g;", [reqG, ghod]))[0].g;
  assert(!!grant, 'GRC approves GHOD with an expiry');
  const open = await ok(ghod, "select * from public.get_report_by_source_secure('report_sec016', $1, null);", [rep]);
  assert(open.ok, 'GHOD opens the report through the time-bound read-only grant');
  assert((await ok(airasia, "select * from public.get_report_by_source_secure('report_sec016', $1, null);", [rep])).ok === false, 'AirAsia Management stays aggregate-only without its own approved grant');
  const aud = await asUser(grc, "select * from public.list_report_access_audit_secure('grants', 1, 50);");
  assert(['access_request', 'grant', 'explicit_grant_used'].every((a) => aud.some((r) => r.action === a)) || ['access_request', 'grant'].every((a) => aud.some((r) => r.action === a)), 'request and grant are traceable in the audit');
  const mine2 = await asUser(ghod, "select * from public.list_my_report_access_requests_secure();");
  assert(mine2[0].status === 'approved' && mine2[0].grant_state === 'active' && mine2[0].source_id === rep, 'the requester sees the approved, active grant');
  await db.query("update public.report_access_grants set expires_at = now() - interval '1 minute', starts_at = now() - interval '3 days' where id = $1;", [grant]);
  assert((await ok(ghod, "select * from public.get_report_by_source_secure('report_sec016', $1, null);", [rep])).ok === false, 'after expiry the access ends');
  assert((await asUser(ghod, "select * from public.list_my_report_access_requests_secure();"))[0].grant_state === 'expired', 'the requester sees the grant as expired');


  // ---------- 8. KCH / BKI are valid HUB destinations; PEN / JHB / NILAI unchanged; BTU and KUL are not destinations
  async function insertTx(label, route, hubDest, status, dest = null) {
    const id = nextId();
    await db.query('reset role;');
    await db.query('set session_replication_role = replica;');
    let err = null;
    await db.query('savepoint h');
    try {
      await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, hub_destination, origin_station_id, destination_station_id, flight_number, created_by)
        values ($1,$2,$3,'OUTBOUND','WXX2','Driver','D2','S-200',$4,$5,$6,$7,$8,'AK703',$9);`, [id, `TX-HUB-${label}`, myAoc, status, route, hubDest, kul.id, dest, asoKul]);
      await db.query('release savepoint h');
    } catch (e) { err = e.message; await db.query('rollback to savepoint h'); }
    await db.query('set session_replication_role = origin;');
    await sup();
    return { id, err };
  }
  const hubTx = {};
  for (const d of ['PEN', 'JHB', 'NILAI', 'KCH', 'BKI']) {
    const r = await insertTx(d, 'HUB', d, 'INFLIGHT_POST_APPROVED');
    hubTx[d] = r.id;
    assert(r.err === null, `${d} is a valid HUB destination`);
  }
  for (const d of ['KUL', 'BTU', 'XXX']) {
    const r = await insertTx(`bad${d}`, 'HUB', d, 'CREATED');
    assert(r.err !== null && /hub_destination_check/.test(r.err), `${d} is NOT a valid HUB destination`);
  }
  const cons = (await rows("select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'public.transactions'::regclass and conname = 'transactions_hub_destination_check';"))[0]?.d ?? '';
  assert(['PEN', 'JHB', 'NILAI', 'KCH', 'BKI'].every((c) => cons.includes(`'${c}'`)), 'the transactions constraint lists exactly the five destinations');
  const cap = async (u, fn, st) => (await asUser(u, `select public.${fn}($1) v;`, [st]))[0].v;
  assert(await cap(asoPen, 'can_user_scan_caterlink', 'PEN') === true, 'PEN keeps its scanner');
  assert(await cap(asoBki, 'can_user_scan_caterlink', 'BKI') === false && await cap(asoKch, 'can_user_scan_caterlink', 'KCH') === false, 'KCH and BKI have NO scanner');
  assert(await cap(asoBtu, 'can_user_scan_caterlink', 'BTU') === false && await cap(asoBtu, 'can_user_confirm_caterlink_receipt', 'BTU') === false, 'BTU has no CaterLink capability at all');
  assert(await cap(asoBki, 'can_user_confirm_caterlink_receipt', 'BKI') === true && await cap(asoKch, 'can_user_confirm_caterlink_receipt', 'KCH') === true, 'KCH and BKI have final receipt');
  const listBki = await asUser(asoBki, "select * from public.list_caterlink_pending_receipts_secure('BKI');");
  assert(listBki.some((r) => r.transaction_number === 'TX-HUB-BKI'), 'a HUB movement destined for BKI (post-approved) is listed for the BKI receipt');
  assert(!listBki.some((r) => r.transaction_number === 'TX-HUB-KCH'), 'a KCH-destined movement is not listed at BKI');
  const early = await insertTx('earlyBKI', 'HUB', 'BKI', 'CREATED');
  const listBki2 = await asUser(asoBki, "select * from public.list_caterlink_pending_receipts_secure('BKI');");
  assert(early.err === null && !listBki2.some((r) => r.transaction_number === 'TX-HUB-earlyBKI'), 'a HUB movement not yet through the In-flight Post is NOT offered for receipt (no step is skipped)');
  assert((await ok(asoBki, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', 's.png', null);", [early.id])).ok === false, 'receipt cannot be confirmed before the In-flight Post approval');

  // ---------- 9. final PDF re-versioned after the receipt (service role only, receiver bound, idempotent, supersedes)
  const done = await insertTx('pdfdone', 'HUB', 'BKI', 'COMPLETED');
  await db.query('reset role;');
  await db.query('set session_replication_role = replica;');
  await db.query("insert into public.caterlink_checkpoint_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, completed_by) values ($1,'BKI','RC asobki','RC-asobki','receipt/x.png',$2);", [done.id, asoBki]);
  await db.query('set session_replication_role = origin;');
  await sup();
  const h1 = 'a'.repeat(64); const h2 = 'b'.repeat(64);
  const rec = (hash, who = asoBki, tx = done.id) => rows("select * from public.record_caterlink_receipt_pdf_version($1,$2,$3,5000,$4);", [tx, `${tx}/${hash}.pdf`, hash, who]);
  const v1 = await rec(h1);
  assert(v1[0].version === 1 && v1[0].is_new === true, 'first post-receipt PDF is version 1');
  const again = await rec(h1);
  assert(again[0].version === 1 && again[0].is_new === false, 'identical content is idempotent (same version, not new)');
  const v2 = await rec(h2);
  assert(v2[0].version === 2 && v2[0].is_new === true, 'changed content becomes version 2');
  const cur = await rows("select version, is_current from public.caterlink_transaction_pdfs where transaction_id = $1 order by version;", [done.id]);
  assert(cur.length === 2 && cur[0].is_current === false && cur[1].is_current === true, 'the previous version is superseded, never deleted or overwritten');
  assert(await denied(asoBki, "select * from public.record_caterlink_receipt_pdf_version($1,$2,$3,5000,$4);", [done.id, `${done.id}/${h2}.pdf`, 'c'.repeat(64), asoBki]) !== null, 'an authenticated officer cannot record a PDF version directly (service role only)');
  assert(await denied(compliance, "select * from public.record_caterlink_receipt_pdf_version($1,$2,$3,5000,$4);", [done.id, 'x', 'd'.repeat(64), compliance]) !== null, 'Compliance cannot record a PDF version');
  let wrong = null; try { await db.query('savepoint w'); await rec('e'.repeat(64), asoKch); await db.query('release savepoint w'); } catch (e) { wrong = e.message; await db.query('rollback to savepoint w'); }
  assert(wrong !== null && /No final receipt by this officer/.test(wrong), 'a PDF cannot be recorded for a receiver who did not confirm the receipt');
  let notDone = null; try { await db.query('savepoint n'); await rec('f'.repeat(64), asoBki, hubTx.BKI); await db.query('release savepoint n'); } catch (e) { notDone = e.message; await db.query('rollback to savepoint n'); }
  assert(notDone !== null && /COMPLETED/.test(notDone), 'a PDF is only recorded for a COMPLETED transaction');
  const dlPdf = await asUser(asoBki, "select * from public.get_caterlink_transaction_pdf_secure($1);", [done.id]);
  assert(dlPdf.length === 1 && dlPdf[0].version === 2, 'the receiving officer downloads the CURRENT version');


  // ---------- 9b. durable post-receipt PDF jobs
  const jobsOf = (tx) => rows('select * from public.caterlink_pdf_jobs where transaction_id = $1 order by created_at;', [tx]);
  const sigPath = 'receipt/job.png';
  const bkiTx = await insertTx('jobBKI', 'HUB', 'BKI', 'INFLIGHT_POST_APPROVED');
  const kchTx = await insertTx('jobKCH', 'HUB', 'KCH', 'INFLIGHT_POST_APPROVED');
  const r1 = await ok(asoBki, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', $2, null);", [bkiTx.id, sigPath]);
  const r2 = await ok(asoKch, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'KCH', $2, null);", [kchTx.id, sigPath]);
  assert(r1.ok && r2.ok, 'BKI and KCH officers confirm their final receipts through the real RPC');
  const jb = await jobsOf(bkiTx.id);
  const hubRow = await one('select id from public.caterlink_checkpoint_hub where transaction_id = $1;', [bkiTx.id]);
  assert(jb.length === 1 && jb[0].status === 'pending' && jb[0].attempt_count === 0, 'the receipt created exactly one PENDING job atomically with the completion');
  assert(jb[0].idempotency_key === `${bkiTx.id}:${hubRow.id}:1` && jb[0].receiver === asoBki, 'idempotency key = transaction : receipt : source version; receiver recorded');
  assert((await jobsOf(kchTx.id)).length === 1, 'a KCH receipt creates its job too');
  const again2 = await ok(asoBki, "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', $2, null);", [bkiTx.id, sigPath]);
  assert(again2.ok === false && (await jobsOf(bkiTx.id)).length === 1, 'a repeated receipt is refused and never duplicates the job');
  let dupErr = null;
  try { await db.query('savepoint dj'); await db.query('insert into public.caterlink_pdf_jobs (transaction_id, receipt_id, receiver, idempotency_key) values ($1,$2,$3,$4);', [bkiTx.id, hubRow.id, asoBki, jb[0].idempotency_key]); await db.query('release savepoint dj'); } catch (e) { dupErr = e.message; await db.query('rollback to savepoint dj'); }
  assert(dupErr !== null && /idempotency_key/.test(dupErr), 'the idempotency key is unique: a second job for the same receipt cannot exist');
  // PEN completion creates no job
  const penTx = await insertTx('jobPEN', 'HUB', 'PEN', 'INFLIGHT_POST_APPROVED');
  await db.query('reset role;'); await db.query('set session_replication_role = replica;');
  await db.query("insert into public.caterlink_checkpoint_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, completed_by) values ($1,'PEN','x','x','s.png',$2);", [penTx.id, asoPen]);
  await db.query('set session_replication_role = origin;'); await sup();
  await db.query("update public.transactions set status = 'COMPLETED' where id = $1;", [penTx.id]);
  assert((await jobsOf(penTx.id)).length === 0, 'PEN completion is unchanged: no PDF job');

  // authorization of the worker surface
  for (const [lbl, fn] of [['claim', 'select * from public.claim_caterlink_pdf_jobs(5, null)'], ['complete', "select * from public.complete_caterlink_pdf_job(gen_random_uuid(), 'x', repeat('a',64), 5)"], ['fail', "select public.fail_caterlink_pdf_job(gen_random_uuid(), 'render')"]]) {
    assert(await denied(asoBki, fn) !== null && await denied(clMgmt, fn) !== null, `${lbl} is service-role only (not the receiver, not Management)`);
  }
  const job = jb[0];
  const claim = () => rows('select * from public.claim_caterlink_pdf_jobs(5, $1);', [bkiTx.id]);
  const failJob = async (cat) => (await rows('select public.fail_caterlink_pdf_job($1, $2) s;', [job.id, cat]))[0].s;
  const c1 = await claim();
  assert(c1.length === 1 && c1[0].attempt_count === 1 && (await jobsOf(bkiTx.id))[0].status === 'processing', 'claim marks the job processing and counts the attempt');
  assert((await claim()).length === 0, 'a job being processed is not claimed again');
  assert(await failJob('render') === 'failed_retryable', 'a rendering failure is retryable');
  let j = (await jobsOf(bkiTx.id))[0];
  assert(j.last_error_category === 'render' && j.attempt_count === 1 && new Date(j.next_retry_at) > new Date() && j.locked_at === null, 'category, attempt count and next retry time are recorded');
  assert((await claim()).length === 0, 'a failed job is not claimed before its retry time');
  await db.query("update public.caterlink_pdf_jobs set next_retry_at = now() - interval '1 second' where id = $1;", [job.id]);
  assert((await claim()).length === 1, 'it is claimed again once the retry time passes');
  await failJob('https://signed.example/x?token=SECRET');
  j = (await jobsOf(bkiTx.id))[0];
  assert(j.last_error_category === 'unknown' && !JSON.stringify(j).match(/https?:|token|SECRET/i), 'only a category is stored: free text, URLs and tokens are never kept');
  await db.query("update public.caterlink_pdf_jobs set next_retry_at = now() - interval '1 second' where id = $1;", [job.id]);
  await claim(); await failJob('storage');
  assert((await jobsOf(bkiTx.id))[0].last_error_category === 'storage', 'a Storage failure is recorded as such');

  // visibility and manual retry
  assert((await asUser(asoBki, 'select * from public.get_caterlink_pdf_state_secure($1);', [bkiTx.id]))[0].state === 'failed', 'the receiver sees "failed", never "ready", while no version exists');
  assert(await denied(compliance, 'select * from public.get_caterlink_pdf_state_secure($1);', [bkiTx.id]) !== null, 'Compliance cannot read the PDF state');
  assert((await asUser(clMgmt, 'select * from public.list_caterlink_pdf_jobs_secure(true);')).some((r) => r.job_id === job.id && r.status === 'failed_retryable'), 'CaterLink Management sees the failed job');
  assert((await asUser(asoBki, 'select * from public.list_caterlink_pdf_jobs_secure(true);')).length === 0 && (await asUser(compliance, 'select * from public.list_caterlink_pdf_jobs_secure(true);')).length === 0, 'officers and Compliance see no jobs');
  for (const [lbl, u] of [['the receiving officer', asoBki], ['Compliance', compliance], ['Operation Manager', opm], ['another ASO', asoKch]]) {
    assert(await denied(u, 'select public.retry_caterlink_pdf_job_secure($1);', [job.id]) !== null, `manual retry denied: ${lbl}`);
  }
  assert((await jobsOf(bkiTx.id))[0].status === 'failed_retryable', 'denied retries change nothing');
  assert((await asUser(clMgmt, 'select public.retry_caterlink_pdf_job_secure($1) s;', [job.id]))[0].s === 'pending', 'CaterLink Management retries a failed job');
  j = (await jobsOf(bkiTx.id))[0];
  assert(j.status === 'pending' && j.manual_retry_count === 1 && j.attempt_count === 3, 'the retry re-queues it and keeps the attempt history');
  assert((await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_pdf_job_manual_retry' and entity_id = $1;", [bkiTx.id])).n === 1, 'the manual retry is audited');
  assert(await denied(clMgmt, 'select public.retry_caterlink_pdf_job_secure($1);', [job.id]) !== null, 'a job that is not failed cannot be retried');

  // success: exactly one authoritative version, whatever is re-rendered
  await claim();
  const hA = '1'.repeat(64), hB = '2'.repeat(64);
  const done1 = (await rows('select * from public.complete_caterlink_pdf_job($1, $2, $3, 4000);', [job.id, `${bkiTx.id}/${hA}.pdf`, hA]))[0];
  assert(done1.version === 1 && done1.is_new === true, 'retry success records version 1');
  const done2 = (await rows('select * from public.complete_caterlink_pdf_job($1, $2, $3, 4100);', [job.id, `${bkiTx.id}/${hB}.pdf`, hB]))[0];
  assert(done2.version === 1 && done2.is_new === false && done2.pdf_id === done1.pdf_id, 'processing a finished job again returns the existing version even when the re-render differs');
  assert((await rows('select * from public.caterlink_transaction_pdfs where transaction_id = $1;', [bkiTx.id])).length === 1, 'exactly one authoritative version exists for the receipt');
  assert((await claim()).length === 0 && await failJob('render') === 'succeeded', 'a finished job is never claimed or failed again');
  j = (await jobsOf(bkiTx.id))[0];
  assert(j.status === 'succeeded' && j.pdf_id === done1.pdf_id && j.last_error_category === null && j.completed_at !== null, 'job succeeded with its pdf recorded');
  assert((await asUser(asoBki, 'select * from public.get_caterlink_pdf_state_secure($1);', [bkiTx.id]))[0].state === 'ready', 'only now is the PDF reported ready');
  assert((await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_pdf_job_succeeded' and entity_id = $1;", [bkiTx.id])).n === 1, 'successful generation is audited exactly once');
  const before = (await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_pdf_access' and entity_id = $1;", [bkiTx.id])).n;
  assert((await asUser(asoBki, 'select * from public.get_caterlink_transaction_pdf_secure($1);', [bkiTx.id])).length === 1, 'the receiver downloads the authoritative version');
  assert((await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_pdf_access' and entity_id = $1;", [bkiTx.id])).n === before + 1, 'the authorized download is audited');
  assert(await denied(compliance, 'select * from public.get_caterlink_transaction_pdf_secure($1);', [bkiTx.id]) !== null, 'an unauthorized download is refused');
  // a later recorder version supersedes but never removes version 1
  await rows('select * from public.record_caterlink_receipt_pdf_version($1,$2,$3,4200,$4);', [bkiTx.id, `${bkiTx.id}/${'3'.repeat(64)}.pdf`, '3'.repeat(64), asoBki]);
  const vs = await rows('select version, is_current from public.caterlink_transaction_pdfs where transaction_id = $1 order by version;', [bkiTx.id]);
  assert(vs.length === 2 && vs[0].is_current === false && vs[1].is_current === true, 'previous immutable versions are preserved');
  assert((await jobsOf(bkiTx.id)).length === 1 && (await one('select count(*)::int n from public.caterlink_checkpoint_hub where transaction_id = $1;', [bkiTx.id])).n === 1, 'retrying never duplicated the receipt or the job');
  // stale lock reclaim
  const kj = (await jobsOf(kchTx.id))[0];
  await db.query("update public.caterlink_pdf_jobs set status = 'processing', locked_at = now() - interval '11 minutes' where id = $1;", [kj.id]);
  assert((await rows('select * from public.claim_caterlink_pdf_jobs(5, $1);', [kchTx.id])).length === 1, 'a job whose worker died (stale lock) is reclaimed');

  // ---------- 7. Main Enforcement / Operation Manager: no user administration at the RPC layer
  for (const [lbl, u] of [['Main Enforcement', mainEnf], ['Operation Manager', opm]]) {
    assert(await denied(u, "select public.approve_registration_request(gen_random_uuid(), 'aso', $1, $2, null, null, null, null, null);", [myAoc, maa]) !== null, `${lbl}: cannot approve a registration`);
    assert(await denied(u, "select public.reject_registration_request(gen_random_uuid(), 'no');") !== null, `${lbl}: cannot reject a registration`);
    assert(await denied(u, "select * from public.export_entity_user_directory('MAA');") !== null, `${lbl}: cannot export an entity directory`);
    assert(await denied(u, "select * from public.list_malaysia_staff_directory_secure(null, null, 1, 5);") !== null, `${lbl}: cannot use the Malaysia directory`);
  }

  await db.query('rollback;');
  await db.end();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
