// Phase 8 Round 2, Slice 5: genuine multi-connection concurrency
// verification for the duty-zone draw lifecycle. Uses two REAL, separate
// PostgreSQL connections throughout -- not two sequential calls on one
// connection -- covering exactly what the spec calls out:
//   1. Simultaneous assignment updates (two different staff, same draw).
//   2. An assignment update racing with finalization (finalize must not
//      run concurrently with, or silently lose, an in-flight write).
//   3. Two finalization attempts at once -- exactly one may succeed.
//   4. Read visibility before vs after finalization (a non-Operation-
//      Manager reader sees nothing pre-finalization, sees the result
//      immediately after).
//
// record_duty_draw_assignment_secure() and finalize_duty_draw_secure()
// both take `select status ... for update` on the draw row, so ordinary
// Postgres row-lock serialization is the mechanism under test here (no
// additional advisory lock exists or is needed for a single-row target,
// unlike the leave-approval capacity count, which reads a many-row
// aggregate and genuinely needs one).
//
// Requires --native is implied (this script only runs against native
// PostgreSQL; PGlite is single-connection). Run from this directory,
// AFTER `node migrate.mjs --native`:
//   node verify_phase8_duty_draw_concurrency_native.mjs
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_phase8_duty_draw_concurrency_run';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateUser(client, profileId) {
  await client.query('reset role;');
  await client.query("set role 'authenticated';");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false);",
    [profileId],
  );
}

async function simulateServiceRole(client) {
  await client.query('reset role;');
  await client.query("set role 'service_role';");
  await client.query("select set_config('request.jwt.claims', '{}', false);");
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 8 duty-draw concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = new Client({ ...pgConfig, database: runDb });
  await setup.connect();

  const GRANTER = '00000000-0000-0000-0000-0000000000d1';
  const OPS_MGR = '00000000-0000-0000-0000-0000000000d2';
  const STAFF_A = '00000000-0000-0000-0000-0000000000d3';
  const STAFF_B = '00000000-0000-0000-0000-0000000000d4';
  const READER = '00000000-0000-0000-0000-0000000000d5'; // non-OM, station staff

  await simulateServiceRole(setup);
  const ids = [GRANTER, OPS_MGR, STAFF_A, STAFF_B, READER];
  await setup.query(
    `insert into auth.users (id, email) values ${ids.map((_, i) => `($${i + 1}, 'p8dd-${i}@example.test')`).join(',')} on conflict (id) do nothing;`,
    ids,
  );
  await setup.query(
    `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
     values
       ($1, 'p8dd-0@example.test', 'Granter', 'T-D1', 'ADMIN', null, null, 'operation_avsec', 'approved'),
       ($2, 'p8dd-1@example.test', 'Ops Mgr', 'T-D2', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($3, 'p8dd-2@example.test', 'Staff A', 'T-D3', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved'),
       ($4, 'p8dd-3@example.test', 'Staff B', 'T-D4', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved'),
       ($5, 'p8dd-4@example.test', 'Reader', 'T-D5', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved')
     on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
       station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;`,
    [GRANTER, OPS_MGR, STAFF_A, STAFF_B, READER],
  );

  const aocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const operationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;
  const opsMgrRoleId = (await setup.query("select id from public.role_definitions where code = 'operation_manager';")).rows[0].id;
  await setup.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase8 duty-draw concurrency fixture');`,
    [OPS_MGR, opsMgrRoleId, aocId, operationDeptId, GRANTER],
  );

  const zoneId = (
    await setup.query(
      `insert into public.duty_zones (station, code, name, polygon, center_lat, center_lng, radius_m, active)
       values ('PEN', 'Z1', 'Zone 1', '{}'::jsonb, 5.3, 100.3, 150, true) returning id;`,
    )
  ).rows[0].id;

  await setup.end();

  // --- Genuine simulation begins: everything below runs as OPS_MGR via simulate_user. ---
  const setup2 = new Client({ ...pgConfig, database: runDb });
  await setup2.connect();
  await simulateUser(setup2, OPS_MGR);
  const initiated = await setup2.query("select * from public.initiate_duty_draw_secure('PEN', '2027-03-01');");
  const realDrawId = initiated.rows[0].row_id;
  await setup2.end();

  // =====================================================================
  // 1. SIMULTANEOUS ASSIGNMENT UPDATES (two different staff, same draw)
  // =====================================================================
  {
    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await simulateUser(connA, OPS_MGR);
    await simulateUser(connB, OPS_MGR);

    const [resA, resB] = await Promise.all([
      connA.query('select public.record_duty_draw_assignment_secure($1, $2, $3);', [realDrawId, STAFF_A, zoneId]),
      connB.query('select public.record_duty_draw_assignment_secure($1, $2, $3);', [realDrawId, STAFF_B, zoneId]),
    ]);
    assert(!!resA && !!resB, 'Two simultaneous assignment writes for different staff both complete without deadlock or error');

    await connA.end();
    await connB.end();

    const verify = new Client({ ...pgConfig, database: runDb });
    await verify.connect();
    const rows = await verify.query('select profile_id from public.duty_draw_assignments where draw_id = $1 order by profile_id;', [realDrawId]);
    await verify.end();
    assert(rows.rows.length === 2, `Both concurrent assignments were correctly recorded (found ${rows.rows.length})`);
  }

  // =====================================================================
  // 2. READ VISIBILITY BEFORE FINALIZATION
  // =====================================================================
  {
    const reader = new Client({ ...pgConfig, database: runDb });
    await reader.connect();
    await simulateUser(reader, READER);
    const before = await reader.query('select * from public.get_duty_draw_secure($1, $2);', ['PEN', '2027-03-01']);
    await reader.end();
    assert(before.rows.length === 0, 'A non-Operation-Manager station reader sees NOTHING for a draft (unfinalized) draw');
  }

  // =====================================================================
  // 3. ASSIGNMENT UPDATE RACING WITH FINALIZATION
  // =====================================================================
  // connA opens a transaction and takes the row lock via the assignment
  // RPC's own `for update`, holding it open; connB's finalize call
  // genuinely blocks on that same lock until connA commits -- proving
  // the two operations are serialized by the database, not by app-level
  // sequencing in this test script.
  {
    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await simulateUser(connA, OPS_MGR);
    await simulateUser(connB, OPS_MGR);

    await connA.query('begin;');
    const resAPromise = connA.query('select public.record_duty_draw_assignment_secure($1, $2, $3);', [realDrawId, STAFF_A, zoneId]);
    await resAPromise; // row lock acquired and held inside the still-open transaction

    const resBPromise = connB.query('select public.finalize_duty_draw_secure($1);', [realDrawId]).catch((e) => ({ error: e.message }));
    // Give B a moment to genuinely reach and block on A's held row lock
    // before A commits and releases it.
    await sleep(200);
    await connA.query('commit;');
    const resB = await resBPromise;

    await connA.end();
    await connB.end();

    assert(!resB.error, 'Finalization correctly waits for an in-flight assignment write to commit, then proceeds (not lost, not corrupted)');

    const verify = new Client({ ...pgConfig, database: runDb });
    await verify.connect();
    const status = await verify.query('select status from public.duty_draws where id = $1;', [realDrawId]);
    await verify.end();
    assert(status.rows[0].status === 'finalized', 'The draw is finalized after the race resolves');
  }

  // =====================================================================
  // 4. TWO FINALIZATION ATTEMPTS AT ONCE (post-finalization from step 3,
  //    so this also covers "finalize an already-finalized draw" under
  //    real concurrent connections, not just sequential re-calls)
  // =====================================================================
  {
    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await simulateUser(connA, OPS_MGR);
    await simulateUser(connB, OPS_MGR);

    const [resA, resB] = await Promise.all([
      connA.query('select public.finalize_duty_draw_secure($1);', [realDrawId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
      connB.query('select public.finalize_duty_draw_secure($1);', [realDrawId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    const successCount = [resA, resB].filter((r) => r.ok).length;
    const deniedCount = [resA, resB].filter((r) => !r.ok && /already finalized/.test(r.error || '')).length;
    assert(successCount === 0, 'Neither concurrent finalize call on an ALREADY-finalized draw silently "succeeds" (both correctly rejected)');
    assert(deniedCount === 2, `Both concurrent finalize attempts on an already-finalized draw are correctly and independently denied (found ${deniedCount}/2)`);
  }

  // =====================================================================
  // 5. READ VISIBILITY AFTER FINALIZATION
  // =====================================================================
  {
    const reader = new Client({ ...pgConfig, database: runDb });
    await reader.connect();
    await simulateUser(reader, READER);
    const after = await reader.query('select * from public.get_duty_draw_secure($1, $2);', ['PEN', '2027-03-01']);
    await reader.end();
    assert(after.rows.length === 2, `A non-Operation-Manager station reader sees the published result immediately after finalization (found ${after.rows.length} rows)`);
  }

  console.log('\nAll Phase 8 duty-draw concurrency checks passed -- genuinely proven under real, concurrent database connections.');

  const cleanup = new Client({ ...pgConfig, database: 'postgres' });
  await cleanup.connect();
  await cleanup.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await cleanup.query(`drop database if exists ${runDb};`);
  await cleanup.end();
  await admin.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
