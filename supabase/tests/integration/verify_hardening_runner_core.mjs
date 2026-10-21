// Guarded staging runner (scripts/staging/apply-hardening-migrations.mjs): runs the runner's own execute() -- the exact code that will run on staging --
// against a disposable database reproducing the hosted pre-state of the two hardening migrations (ACL changes and the repaired profile guard reverted:
// every excess privilege granted again, the canonical guard body installed). Proves the gates refuse a wrong state, the dry run passes every probe and
// leaves the database unchanged, the live pass commits both migrations atomically, and a second run is refused. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_hardening_runner_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const runner = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts', 'staging', 'apply-hardening-migrations.mjs')).href);
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_hardening_runner_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Hardening guarded runner core against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Hardening guarded runner core against PGlite ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) { console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.'); process.exit(1); }
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
    fs.cpSync(GOLDEN_DATA_DIR, RUN_DATA_DIR, { recursive: true });
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    const batch = async (s) => { const r = await pgliteDb.exec(s); const last = r[r.length - 1] ?? { rows: [], fields: [] }; return { ...last, rowCount: last.rows.length || last.affectedRows || 0 }; };
    db = { exec: (s) => pgliteDb.exec(s), query: (s, p) => (p === undefined ? batch(s) : pgliteDb.query(s, p).then((r) => ({ ...r, rowCount: r.rows.length || r.affectedRows || 0 }))), close: () => pgliteDb.close() };
  }
  const one = async (s, p) => (await db.query(s, p)).rows[0];
  const rows = async (s, p) => (await db.query(s, p)).rows;

  // ---- personas under the manifest labels the runner uses
  await db.exec("select set_config('request.jwt.claims', '{}', false), set_config('role', 'service_role', false);");
  let seq = 0x9f00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const accounts = new Map();
  async function profile(label, status = 'approved') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `hd-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,null,null) on conflict (id) do update set status = excluded.status;", [id, `hd-${label}@example.test`, `HD ${label}`, `HD-${label}`.slice(0, 20), status]);
    accounts.set(label, id);
    return id;
  }
  async function stationOfficer(label, stationCode, entity) {
    const st = await one('select id, hub_id from public.org_stations where code = $1;', [stationCode]);
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]);
    const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id;
    const id = await profile(label);
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, entity])).id;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9);', [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, team, m, iso(-DAY)]);
    return id;
  }
  await stationOfficer('aso', 'KUL - MAA', maa);
  const otherCode = (await one("select code from public.org_stations where code <> 'KUL - MAA' and is_active order by code limit 1;")).code;
  await stationOfficer('aso-jhb', otherCode, aax);
  for (const [role, entity] of [['maa_admin', maa], ['aax_admin', aax]]) {
    const id = await profile(role);
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1,$2,$3,$4,$5);', [id, roleMap.get(role), myAoc, entity, iso(-DAY)]);
  }
  await profile('neg-pending-profile', 'pending');
  const acct = (label) => accounts.get(label) ?? (() => { throw new Error(`no ${label}`); })();
  await db.exec('reset role;');
  await db.exec("select set_config('request.jwt.claims', '', false);");
  await db.exec('alter table public.profiles disable trigger user;');
  for (const [label, st] of [['aso', 'KUL - MAA'], ['aso-jhb', otherCode]]) await db.query("update public.profiles set station = $1, team = 'ALPHA' where id = $2", [st, acct(label)]);
  await db.exec('alter table public.profiles enable trigger user;');
  // hosted's required-column sets (the canonical chain has extra NOT NULL columns hosted never had)
  await db.exec('alter table public.report_sec033 alter column report_date drop not null;').catch(() => {});
  const extra033 = (await rows("select column_name from information_schema.columns where table_schema='public' and table_name='report_sec033' and is_nullable='NO' and column_default is null and is_generated='NEVER' and column_name <> all($1)", [['profile_id', 'station', 'team', 'staff_name', 'staff_id', 'report_date', 'report_time']])).map((r) => r.column_name);
  if (extra033.length) await db.exec('alter table public.report_sec033 ' + extra033.map((c) => 'alter column ' + c + ' drop not null').join(', ') + ';');

  // ---- reproduce the hosted pre-state: every excess privilege granted again, the canonical guard body installed
  const T = (n) => 'public.' + n;
  await db.exec(runner.REVOKE_TABLE_NAMES.map((t) => `grant truncate, trigger, references on table ${T(t)} to authenticated;`).join('\n'));
  await db.exec(runner.REVOKE_VIEW_NAMES.map((t) => `grant insert, update, delete on table ${T(t)} to authenticated;`).join('\n'));
  await db.exec('grant delete on table public.shift_handovers to authenticated;');
  await db.exec(runner.REVOKE_FUNCTION_NAMES.map((f) => `grant execute on function public.${f}() to authenticated;`).join('\n'));
  const canonicalSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261102000002_entity_staff_maintenance.sql'), 'utf8');
  const canonicalGuard = /create or replace function public\.enforce_profile_self_update\(\)[\s\S]*?\$function\$;/i.exec(canonicalSrc)[0];
  await db.exec(canonicalGuard);
  await db.exec("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  await db.exec("delete from supabase_migrations.schema_migrations where version >= '20261118000004';");
  if ((await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n === 0) await db.exec("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261118000003', 'p0_profile_approval_audit', '{}');");
  const preCount = (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n;
  const state = async () => JSON.stringify({
    tp: (await rows(runner.__tablePrivSql ?? "select c.relname||':'||r.rolname||':'||p as k from pg_class c cross join unnest(array['anon','authenticated','service_role']) r(rolname) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.rolname, c.oid, p) order by 1")).map((r) => r.k),
    guard: (await one("select md5(pg_get_functiondef('public.enforce_profile_self_update()'::regprocedure)) h")).h,
    hist: (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n,
  });

  const readFile = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f));
  const files = runner.verifyFrozenMigrations(readFile);
  assert(files.length === 2 && files.every((f) => runner.normalisedSha256(Buffer.from(f.sql)) === f.sha256), 'the frozen SHA-256 of both migrations matches the files');
  const logs = [];
  const base = { files, acct, log: (m) => logs.push(m), preCount, lastPre: '20261118000003', hashes: null };
  const before = await state();
  assert(JSON.parse(before).tp.some((k) => /:authenticated:TRUNCATE$/.test(k)), 'the fixture reproduces the excess: authenticated holds TRUNCATE again');

  // ---- gates refuse a wrong state, and refusal changes nothing
  const refuse = async (label, ctx, rx) => {
    let msg = null;
    try { await runner.execute(db, ctx); } catch (e) { msg = e.message; }
    assert(msg !== null && rx.test(msg), `${label} (${msg})`);
    assert((await state()) === before, `${label}: database unchanged`);
  };
  await refuse('a wrong history count is refused', { ...base, preCount: base.preCount + 1 }, /history is not exactly/);
  await refuse('a wrong last migration is refused', { ...base, lastPre: '20261115000001' }, /history is not exactly/);
  await refuse('an observed-state hash mismatch is refused', { ...base, hashes: { ...runner.PRE_STATE, tablePrivsMd5: '0'.repeat(32) } }, /differ(s)? from the observed pre-state/);
  await refuse('tampered SQL is refused', { ...base, files: [{ ...files[0], sql: files[0].sql + '\n-- x' }, files[1]] }, /does not match its frozen SHA-256/);
  await refuse('an extra statement outside the allow-list is refused', { ...base, files: [{ ...files[0], sql: files[0].sql + '\ngrant all on public.profiles to anon;', sha256: undefined }, files[1]] }, /outside the reviewed allow-list/);

  // ---- dry run
  const dry = await runner.execute(db, { ...base, live: false });
  assert(dry.committed === false && dry.probes.length >= 10, `dry run passes ${dry.probes.length} probes and commits nothing`);
  assert((await state()) === before, 'dry run leaves privileges, the guard body and history exactly as they were');
  assert(logs.some((m) => /staging is unchanged after the dry-run rollback/.test(m)), 'the dry-run unchanged-proof ran');
  for (const p of dry.probes) console.log('   probe:', p);
  let wrongCount = null; try { await runner.execute(db, { ...base, live: false, expectedProbes: dry.probes.length + 1 }); } catch (e) { wrongCount = e.message; }
  assert(wrongCount && /incomplete probe execution/.test(wrongCount), `a probe-count mismatch is refused (${wrongCount})`);

  // ---- live pass (disposable copy only)
  const live = await runner.execute(db, { ...base, live: true });
  assert(live.committed === true, 'live pass commits');
  const after = JSON.parse(await state());
  assert(after.hist === preCount + 2, `exactly two history rows were added (${preCount} -> ${after.hist})`);
  assert(!after.tp.some((k) => /:authenticated:(TRUNCATE|TRIGGER|REFERENCES)$/.test(k) && !/^role_definitions:/.test(k)) , 'no table keeps TRUNCATE / TRIGGER / REFERENCES for authenticated');
  assert(after.tp.some((k) => k === 'profiles:authenticated:UPDATE') && after.tp.some((k) => k === 'shift_handovers:authenticated:INSERT') && !after.tp.includes('shift_handovers:authenticated:DELETE'), 'designed privileges stay (profiles UPDATE, shift_handovers INSERT) and the unintended shift_handovers DELETE is gone');
  assert(after.tp.filter((k) => /:service_role:TRUNCATE$/.test(k)).length === JSON.parse(before).tp.filter((k) => /:service_role:TRUNCATE$/.test(k)).length, 'service_role keeps TRUNCATE everywhere');
  const v = await runner.verifyApplied(async (s, p) => (await db.query(s, p)).rows, { postCount: preCount + 2, postLast: runner.POST_LAST });
  assert(v.last === runner.POST_LAST, 'verifyApplied (the read-only post-apply check) passes on the applied state');

  // ---- a second run is refused
  let again = null;
  try { await runner.execute(db, { ...base, live: true }); } catch (e) { again = e.message; }
  assert(again !== null && /history is not exactly/.test(again), `re-running after the apply is refused (${again})`);
  let againPost = null;
  try { await runner.execute(db, { ...base, preCount: after.hist, lastPre: runner.POST_LAST, live: true }); } catch (e) { againPost = e.message; }
  assert(againPost !== null && /already recorded|none of the privileges/.test(againPost), `re-running with the post-state expectation is refused (${againPost})`);

  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
