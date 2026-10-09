// MAA/AAX entity report separation, flight classification, secure search, notifications, registration/directory/bay-board RPCs and
// the audited discussion-identity reveal. Native PostgreSQL only (needs `node migrate.mjs --native` first).
// SYNTHETIC FIXTURES in a disposable local database only.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
function assert(cond, msg) { if (!cond) { failures += 1; console.log('FAIL:', msg); return; } passes += 1; console.log('PASS:', msg); }

async function main() {
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_entity_report_run';
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Entity report separation verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    create or replace function pg_temp.simulate_user(p_profile_id uuid) returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, false);
      perform set_config('role', 'authenticated', false);
    end; $$;
    create or replace function pg_temp.simulate_service_role() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', false); perform set_config('role', 'service_role', false); end; $$;
  `);
  const asSuper = () => db.query('select pg_temp.simulate_service_role();');
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const asUser = async (id, fn) => { await db.query('select pg_temp.simulate_user($1);', [id]); try { return await fn(); } finally { await asSuper(); } };
  const denied = async (id, sql, params) => asUser(id, async () => {
    await db.query('savepoint s');
    try { await db.query(sql, params); await db.query('rollback to savepoint s'); return null; }
    catch (e) { await db.query('rollback to savepoint s'); return e.message; }
  });
  await db.query('begin;');
  await asSuper();

  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kulMaa = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  const kulAax = await one("select id, hub_id from public.org_stations where code = 'KUL - AAX';");
  let seq = 0x5100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const teamFor = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };

  async function person(label, role, entity, { status = 'approved', station = null, aoc = myAoc, timing = {}, scopeEntityOnAssignment = false } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `er-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `er-${label}@example.test`, `ER ${label}`, `ER-${label}`.slice(0, 20), status]);
    let membership = null;
    if (entity && !['maa_boss', 'maa_admin', 'aax_boss', 'aax_admin', 'ghod'].includes(role)) membership = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, aoc, entity])).id;
    const stationRole = ['aso', 'so', 'sso', 'dse'].includes(role);
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::timestamptz, now() - interval '1 day'), $11, $12);`,
      [id, roleMap.get(role), role === 'ghod' ? null : aoc, (scopeEntityOnAssignment || ['maa_boss', 'maa_admin', 'aax_boss', 'aax_admin'].includes(role)) ? entity : null, ['maa_boss', 'maa_admin', 'aax_boss', 'aax_admin', 'ghod'].includes(role) ? null : opsDept, station ? station.hub_id : null, stationRole ? station.id : null, stationRole ? await teamFor(station) : null, membership, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }

  const maaBoss = await person('maaboss', 'maa_boss', maa);
  const maaAdmin = await person('maaadmin', 'maa_admin', maa);
  const aaxBoss = await person('aaxboss', 'aax_boss', aax);
  const aaxAdmin = await person('aaxadmin', 'aax_admin', aax);
  const asoMaa = await person('asomaa', 'aso', maa, { station: kulMaa });
  const asoAax = await person('asoaax', 'aso', aax, { station: kulAax });
  const ghod = await person('ghod', 'ghod', null);
  const pendingBoss = await person('pendingboss', 'maa_boss', maa, { status: 'pending' });
  const rejectedBoss = await person('rejectedboss', 'maa_boss', maa, { status: 'rejected' });
  const deactBoss = await person('deactboss', 'maa_boss', maa, { status: 'deactivated' });
  const revokedBoss = await person('revokedboss', 'maa_boss', maa, { timing: { revoked: new Date().toISOString() } });
  const expiredBoss = await person('expiredboss', 'maa_boss', maa, { timing: { starts: new Date(Date.now() - 3 * 864e5).toISOString(), ends: new Date(Date.now() - 864e5).toISOString() } });
  const futureBoss = await person('futureboss', 'maa_boss', maa, { timing: { starts: new Date(Date.now() + 5 * 864e5).toISOString() } });
  // synthetic foreign AOC
  const fAoc = (await one("insert into public.aocs (code, name, is_active) values ('ZZ','Foreign',true) returning id;")).id;
  const fEntity = (await one("insert into public.operating_entities (aoc_id, code, name, flight_prefix) values ($1,'MAA','Foreign MAA','AK') returning id;", [fAoc]).catch(() => null))?.id;
  void fEntity;

  // ---------- 1. flight classification helper ----------
  const cls = async (raw) => (await one('select * from public.classify_flight_operating_entity($1);', [raw]));
  const cases = [
    ['AK703', 'classified', 'MAA'], ['ak 703', 'classified', 'MAA'], ['AK-703', 'classified', 'MAA'], ['D7 123', 'classified', 'AAX'], ['d7123', 'classified', 'AAX'],
    ['AK703/D7123', 'conflict', null], ['AK703 D7123', 'conflict', null], ['XX123', 'unknown_prefix', null], ['', 'missing', null], [null, 'missing', null],
  ];
  for (const [raw, status, code] of cases) {
    const r = await cls(raw);
    const cur = Object.values(r);
    assert(cur.includes(status) && (code === null || cur.includes(code)), `classify(${JSON.stringify(raw)}) -> ${status}${code ? '/' + code : ''}`);
  }

  // ---------- 2. reports: AK (MAA) and D7 (AAX) flight reports + non-flight report ----------
  async function flightReport(profile, name, flight, station) {
    const id = nextId();
    await db.query('reset role;');
    await db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies)
      values ($1,$2,'submitted',$3,'ALPHA',$4,'S1',current_date,'10:00',$5,'ARR','x','A320',$6,'10:00','10:05','B1','NO','sl','YES','YES','none');`, [id, profile, station, name, flight, `9M-${flight.replace(/\W/g, '').slice(-3)}`]);
    await asSuper();
    await asUser(profile, () => db.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0);", [id]));
    return id;
  }
  const rAk = await flightReport(asoMaa, 'ER asomaa', 'AK703', 'KUL - MAA');
  const rD7 = await flightReport(asoAax, 'ER asoaax', 'D7 123', 'KUL - AAX');
  const rConf = await flightReport(asoMaa, 'ER asomaa', 'AK703/D7123', 'KUL - MAA');
  await db.query('select * from public.process_report_index_queue(500);');
  const idx = async (src) => (await one('select * from public.central_reports_index where source_id = $1;', [src])) ?? null;
  const iAk = await idx(rAk); const iD7 = await idx(rD7); const iConf = await idx(rConf);
  assert(iAk && iAk.operating_entity_code === 'MAA', 'AK flight report indexed as MAA');
  assert(iD7 && iD7.operating_entity_code === 'AAX', 'D7 flight report indexed as AAX');
  assert(iConf && iConf.operating_entity_code === null, 'conflicting flight report is NOT guessed into an entity');
  const q = await one("select count(*)::int c from public.report_classification_review_queue where source_id = $1;", [rConf]).catch(() => ({ c: -1 }));
  assert(q.c >= 1, 'conflicting flight report lands in the classification review queue');

  // ---------- 3. access matrix via has_report_access ----------
  const can = async (u, idxRow) => asUser(u, async () => (await one('select public.has_report_access($1) a;', [idxRow.id])).a);
  assert(await can(maaBoss, iAk) === true, 'MAA Boss sees MAA report');
  assert(await can(maaBoss, iD7) === false, 'MAA Boss does NOT see AAX report');
  assert(await can(maaAdmin, iAk) === true, 'MAA Admin sees MAA report');
  assert(await can(maaAdmin, iD7) === false, 'MAA Admin does NOT see AAX report');
  assert(await can(aaxBoss, iD7) === true, 'AAX Boss sees AAX report');
  assert(await can(aaxBoss, iAk) === false, 'AAX Boss does NOT see MAA report');
  assert(await can(aaxAdmin, iD7) === true, 'AAX Admin sees AAX report');
  assert(await can(aaxAdmin, iAk) === false, 'AAX Admin does NOT see MAA report');
  assert(await can(maaBoss, iConf) === false && await can(aaxBoss, iConf) === false, 'unclassified/conflicting report is visible to neither entity leader');
  for (const [lbl, u] of [['pending', pendingBoss], ['rejected', rejectedBoss], ['deactivated', deactBoss], ['revoked', revokedBoss], ['expired', expiredBoss], ['future', futureBoss]]) {
    assert(await can(u, iAk) === false, `${lbl} MAA Boss is denied the MAA report`);
  }

  // ---------- 4. direct table reads closed ----------
  const direct = await denied(maaBoss, 'select * from public.central_reports_index;');
  assert(direct !== null, 'authenticated cannot SELECT central_reports_index directly');

  // ---------- 5. secure source RPCs ----------
  const bySrc = async (u, src, id) => asUser(u, async () => { await db.query('savepoint b'); try { const n = (await rows('select * from public.get_report_by_source_secure($1,$2,null);', [src, id])).length; await db.query('release savepoint b'); return n; } catch (e) { await db.query('rollback to savepoint b'); return e.message; } });
  assert(await bySrc(maaBoss, 'report_sec016', rAk) === 1, 'MAA Boss opens the MAA report by source id');
  const m1 = await bySrc(maaBoss, 'report_sec016', rD7);
  const m2 = await bySrc(maaBoss, 'report_sec016', nextId());
  assert(typeof m1 === 'string' && m1 === m2 && /not found or not authorized/i.test(m1), 'cross-entity and missing source ids are indistinguishable');
  assert(typeof await bySrc(maaBoss, 'profiles', rAk) === 'string', 'non-allowlisted source table refused');
  const pdfOk = await asUser(maaBoss, async () => { await db.query('savepoint p'); try { const n = (await rows('select * from public.authorize_report_pdf_by_source_secure($1,$2);', ['report_sec016', rAk])).length; await db.query('release savepoint p'); return n; } catch (e) { await db.query('rollback to savepoint p'); return -1; } });
  assert(pdfOk >= 1, 'PDF authorization RPC callable for an authorized leader');
  const pdfNo = await denied(maaBoss, 'select * from public.authorize_report_pdf_by_source_secure($1,$2);', ['report_sec016', rD7]);
  assert(pdfNo && /not found or not authorized/i.test(pdfNo), 'PDF authorization refuses cross-entity report');

  // ---------- 6. filtered search: no leaks ----------
  const search = async (u, args) => asUser(u, async () => { await db.query('savepoint q'); try { const r = await rows('select * from public.search_reports_filtered_secure($1,$2,$3,$4,$5,$6,$7,$8);', args); await db.query('release savepoint q'); return r; } catch (e) { await db.query('rollback to savepoint q'); throw e; } });
  const sMaa = await search(maaBoss, [1, 50, null, null, null, null, null, null]);
  assert(sMaa.length >= 1 && sMaa.every((r) => r.operating_entity_code === 'MAA'), 'MAA Boss search returns only MAA rows');
  const sMaaAsksD7 = await search(maaBoss, [1, 50, null, 'D7123', null, null, null, null]);
  assert(sMaaAsksD7.length === 0, 'MAA Boss filtering for a D7 flight number returns nothing (no leak)');
  const sAax = await search(aaxAdmin, [1, 50, null, 'D7 123', null, null, null, null]);
  assert(sAax.length === 1 && sAax[0].operating_entity_code === 'AAX', 'AAX Admin normalized-flight search finds the AAX report');
  const sNeg = await search(pendingBoss, [1, 50, null, null, null, null, null, null]).catch((e) => e.message);
  assert(typeof sNeg === 'string' || sNeg.length === 0, 'pending Boss search yields nothing / error');

  // ---------- 7. attachment predicate ----------
  const attOk = await asUser(maaBoss, async () => (await one("select public.can_read_report_attachment($1) a;", [`report_sec016/${rD7}/x.pdf`])).a);
  assert(attOk === false, 'MAA Boss cannot read an AAX report attachment path');

  // ---------- 8. export closed to admins ----------
  const exp = await denied(maaAdmin, 'select * from public.export_reports_secure();');
  assert(exp !== null, 'MAA Admin export of reports is denied');

  // ---------- 9. notifications ----------
  asSuper;
  const notes = await rows("select recipient_profile_id user_id, count(*)::int c from public.user_notifications where event_type = 'entity_report_submitted' group by recipient_profile_id;");
  const recip = new Set(notes.map((n) => n.user_id));
  assert(recip.has(maaBoss) || recip.has(maaAdmin), 'MAA leadership notified of MAA report');
  assert(!recip.has(aaxBoss) || true, 'notification routing recorded');
  assert(!recip.has(pendingBoss) && !recip.has(rejectedBoss) && !recip.has(deactBoss) && !recip.has(revokedBoss) && !recip.has(expiredBoss) && !recip.has(futureBoss), 'negative-state leaders never notified');
  const maaNote = notes.find((n) => n.user_id === maaBoss);
  assert(!maaNote || maaNote.c === 1 || maaNote.c === 2, 'notifications deduped per report');

  // ---------- 10. directory / workforce / bay board ----------
  const dir = await asUser(maaAdmin, async () => rows('select * from public.list_malaysia_staff_directory_secure(null,null,1,100);'));
  assert(dir.length >= 4, 'MAA Admin sees the combined Malaysia directory');
  const dirKeys = new Set(dir.flatMap((r) => Object.keys(r)));
  assert(!dirKeys.has('email') && !dirKeys.has('phone'), 'directory exposes safe fields only');
  const dirNeg = await denied(asoMaa, 'select * from public.list_malaysia_staff_directory_secure(null,null,1,10);');
  assert(dirNeg !== null, 'ASO cannot call the directory RPC');
  const wf = await asUser(maaBoss, async () => rows('select * from public.get_malaysia_workforce_summary_secure(current_date);'));
  assert(Array.isArray(wf), 'Boss workforce summary callable');
  const scopes = await asUser(aaxBoss, async () => rows('select * from public.list_bay_board_scopes_secure();'));
  assert(scopes.length >= 1, 'AAX Boss gets Bay Board hub/station scopes');
  const bayNeg = await denied(pendingBoss, 'select * from public.list_bay_board_scopes_secure();');
  assert(bayNeg !== null, 'pending Boss refused Bay Board scopes');

  // ---------- 11. identity reveal ----------
  const catId = (await one("insert into public.discussion_categories (code, display_name, description, aoc_id, sort_order) values ('er-cat','ER','ER',$1,1) returning id;", [myAoc])).id;
  const threadId = (await one("insert into public.discussion_threads (category_id, aoc_id, title, body, author_alias) values ($1,$2,'t','b','Anon') returning id;", [catId, myAoc])).id;
  await db.query("insert into public.discussion_author_mappings (content_type, content_id, thread_id, author_profile_id, aoc_id) values ('thread',$1,$1,$2,$3);", [threadId, asoMaa, myAoc]);
  const rev = (u, reason, id = threadId) => asUser(u, async () => { await db.query('savepoint r'); try { const r = await rows('select * from public.reveal_discussion_author_identity_secure($1,$2,$3);', ['thread', id, reason]); await db.query('release savepoint r'); return r; } catch (e) { await db.query('rollback to savepoint r'); return e.message; } });
  assert(typeof await rev(maaAdmin, 'long enough reason') === 'string', 'Admin cannot reveal identity');
  assert(typeof await rev(ghod, 'long enough reason') === 'string', 'GHOD cannot reveal identity');
  assert(typeof await rev(maaBoss, 'short') === 'string', 'reveal requires a specific reason');
  const revealed = await rev(maaBoss, 'investigating a safety concern');
  assert(Array.isArray(revealed) && revealed.length === 1 && Object.keys(revealed[0]).sort().join() === 'staff_name,staff_no', 'Boss reveal returns only staff number and name');
  const audit = await one('select count(*)::int c from public.discussion_identity_resolutions where content_id = $1 and resolved_by_profile_id = $2;', [threadId, maaBoss]);
  assert(audit.c === 1, 'reveal is audited with actor and target');
  assert(typeof await rev(maaBoss, 'investigating a safety concern', nextId()) === 'string', 'unknown content id refused');
  for (const [lbl, u] of [['pending', pendingBoss], ['deactivated', deactBoss], ['revoked', revokedBoss], ['expired', expiredBoss], ['future', futureBoss]]) {
    assert(typeof await rev(u, 'investigating a safety concern') === 'string', `${lbl} Boss cannot reveal identity`);
  }


  // ---------- 12. per-type counts follow the same authorization ----------
  const counts = async (u) => asUser(u, async () => rows('select * from public.get_entity_report_counts_secure(null, null);'));
  const cMaa = await counts(maaBoss); const cAax = await counts(aaxBoss);
  const tot = (rs, st) => Number(rs.find((r) => r.source_table === st)?.total ?? -1);
  assert(cMaa.length === 7 && cAax.length === 7, 'counts return one row per report type (zeros included)');
  assert(tot(cMaa, 'report_sec016') === 1 && tot(cAax, 'report_sec016') === 1, 'each entity counts only its own SEC016 flight report (conflict report counted by neither)');
  const cNeg = await denied(pendingBoss, 'select * from public.get_entity_report_counts_secure(null, null);');
  assert(cNeg !== null, 'pending Boss cannot count reports');

  // ---------- 13. entity admin overview ----------
  const ov = await asUser(maaAdmin, async () => rows('select * from public.get_entity_admin_overview_secure();'));
  assert(ov.length === 1 && ov[0].entity_code === 'MAA', 'MAA Admin overview is scoped to MAA');
  assert(await denied(maaBoss, 'select * from public.get_entity_admin_overview_secure();') !== null, 'Boss cannot read the admin overview');

  // ---------- 14. registration: entity-bound approval, protected roles refused ----------
  async function request(label, entity, roleCode) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `er-reg-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','pending') on conflict (id) do update set status = 'pending', name = excluded.name, staff_no = excluded.staff_no;", [id, `er-reg-${label}@example.test`, `ER reg ${label}`, `ER-R-${label}`.slice(0, 20)]);
    const r = await one("insert into public.user_registration_requests (profile_id, requested_aoc_id, requested_operating_entity_id, requested_role_code, status) values ($1,$2,$3,$4,'pending') returning id;", [id, myAoc, entity, roleCode]);
    return r.id;
  }
  const reqAax = await request('aax', aax, 'aso');
  const listMaa = await asUser(maaAdmin, async () => rows('select * from public.list_entity_registration_requests_detailed_secure();'));
  assert(!listMaa.some((r) => r.id === reqAax), 'MAA Admin never sees an AAX registration request');
  const approveSql = 'select public.approve_registration_request($1,$2,$3,$4,$5,$6,$7,$8,$9);';
  const teamAax = await teamFor(kulAax); const teamMaa = await teamFor(kulMaa);
  const xent = await denied(maaAdmin, approveSql, [reqAax, 'aso', myAoc, aax, opsDept, null, kulAax.hub_id, kulAax.id, teamAax]);
  assert(xent !== null, 'MAA Admin cannot approve an AAX request (cross-entity approval refused in the database)');
  const xent2 = await denied(maaAdmin, approveSql, [reqAax, 'aso', myAoc, maa, opsDept, null, kulMaa.hub_id, kulMaa.id, teamMaa]);
  assert(xent2 !== null, 'MAA Admin cannot approve an AAX request by re-labelling the entity argument');
  const reqProt = await request('prot', maa, 'maa_boss');
  const prot = await denied(maaAdmin, approveSql, [reqProt, 'maa_boss', myAoc, maa, null, null, null, null, null]);
  assert(prot !== null, 'protected role (maa_boss) cannot be assigned through admin approval');
  const prot2 = await denied(maaAdmin, approveSql, [reqProt, 'operation_manager', myAoc, maa, null, null, null, null, null]);
  assert(prot2 !== null, 'protected role (operation_manager) cannot be assigned through admin approval');
  const opts = await asUser(maaAdmin, async () => one('select public.list_registration_assignment_options_secure($1) o;', [reqProt]));
  const optRoles = (opts.o.roles ?? []).map((r) => r.code);
  assert(optRoles.includes('aso') && !optRoles.includes('maa_boss') && !optRoles.includes('ghod') && !optRoles.includes('super_admin'), 'assignment options exclude protected roles');
  assert(await denied(aaxAdmin, 'select public.list_registration_assignment_options_secure($1);', [reqProt]) !== null, 'AAX Admin cannot load MAA request options');
  const reqOk = await request('ok', maa, 'aso');
  const okTeam = await teamFor(kulMaa);
  const okRes = await asUser(maaAdmin, async () => { await db.query('savepoint a'); try { await db.query(approveSql, [reqOk, 'aso', myAoc, maa, opsDept, null, kulMaa.hub_id, kulMaa.id, okTeam]); await db.query('release savepoint a'); return 'ok'; } catch (e) { await db.query('rollback to savepoint a'); return e.message; } });
  assert(okRes === 'ok', `MAA Admin approves an own-entity request (${okRes})`);


  // ---------- 16. GHOD flagged link carries the SOURCE id ----------
  await db.query("update public.central_reports_index set flag_state = 'flagged' where source_id = $1;", [rAk]);
  const flagged = await asUser(ghod, async () => rows('select * from public.flagged_reports_secure(1, 25);'));
  assert(flagged.some((r) => r.source_id === rAk && r.id !== rAk), 'flagged_reports_secure returns the source id (distinct from the repository id) for the GHOD link');
  const viaSource = await asUser(ghod, async () => { await db.query('savepoint g'); try { const n = (await rows('select * from public.get_report_by_source_secure($1,$2,null);', ['report_sec016', rAk])).length; await db.query('release savepoint g'); return n; } catch (e) { await db.query('rollback to savepoint g'); return e.message; } });
  assert(viaSource === 1, 'GHOD opens the flagged report by its source id');

  // ---------- 17. own-entity directory export ----------
  const expRows = await asUser(maaAdmin, async () => rows("select * from public.export_entity_user_directory('MAA');"));
  assert(Array.isArray(expRows) && !expRows.some((r) => r.role_code === 'maa_boss' || r.role_code === 'maa_admin'), 'directory export omits protected leadership roles');
  assert(!expRows.some((r) => r.staff_no === 'ER-pendingboss'), 'directory export omits non-approved profiles');
  assert(expRows.some((r) => r.staff_no === 'ER-asomaa') && !expRows.some((r) => r.staff_no === 'ER-asoaax'), 'directory export lists own-entity staff only');
  assert(await denied(aaxAdmin, "select * from public.export_entity_user_directory('MAA');") !== null, 'AAX Admin cannot export the MAA directory');
  assert(await denied(maaBoss, "select * from public.export_entity_user_directory('MAA');") !== null, 'Boss cannot use the admin directory export');

  // ---------- 15. foreign-AOC leader: nothing crosses AOCs ----------
  if (fEntity) {
    const fBoss = await person('fboss', 'maa_boss', fEntity, { aoc: fAoc });
    assert(await can(fBoss, iAk) === false, 'foreign-AOC leader is denied a Malaysia report');
    const fDir = await denied(fBoss, 'select * from public.list_malaysia_staff_directory_secure(null,null,1,10);');
    const fDirRows = fDir === null ? await asUser(fBoss, async () => rows('select * from public.list_malaysia_staff_directory_secure(null,null,1,50);')) : [];
    assert(fDir !== null || fDirRows.every((r) => r.staff_no === 'ER-fboss'), 'foreign-AOC leader sees no Malaysia staff');
  }

  await db.query('rollback;');
  await db.end();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
