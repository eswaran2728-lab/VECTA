// Phase 9 correction (round 3): proves the renamed CaterLink checkpoint
// tables (caterlink_checkpoint_part_a/part_d/hub/redq) never collide with
// pre-existing legacy ICMS tables of the SAME original names (part_a,
// part_d, part_hub, part_redq -- see icms/20260101000001_schema.sql and
// icms/20260817000002_multiroute_redq_restructure.sql).
//
// This harness's migrate.mjs deliberately never applies icms/ (see its
// own EXCLUDED list), so the golden template has no legacy part_a/part_d/
// part_hub/part_redq tables to begin with -- there is nothing for a prior
// Phase 9 draft to have collided with inside this harness, which is
// exactly how the original collision went undetected. This script
// closes that gap directly: it creates legacy-shaped part_a/part_d/
// part_hub/part_redq tables (matching icms/'s real columns/constraints),
// seeds representative rows into them, THEN re-applies this migration's
// actual SQL text -- proving the migration (a) still succeeds, (b)
// leaves every legacy table's column list and seeded rows completely
// unchanged, (c) creates the renamed CaterLink tables as entirely
// separate objects, and (d) attaches no CaterLink trigger/policy to any
// legacy-named table.
//
// Requires native PostgreSQL. Run from this directory, AFTER
// `node migrate.mjs --native`:
//   node verify_phase9_legacy_collision_non_regression_native.mjs
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  connectionTimeoutMillis: 15000,
  query_timeout: 30000,
  statement_timeout: 30000,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_phase9_legacy_collision_run';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.log('FAIL:', msg);
    return;
  }
  console.log('PASS:', msg);
}

async function columnList(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position;`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 9 legacy-collision non-regression verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  await admin.end();

  const client = new Client({ ...pgConfig, database: runDb });
  await client.connect();

  try {
    console.log('Step 1: Creating legacy-shaped part_a/part_d/part_hub/part_redq tables (simulating a pre-existing production database that already ran icms/)...');
    await client.query(`
      create table public.part_a (
        id uuid primary key default gen_random_uuid(),
        transaction_id uuid not null unique references public.transactions (id) on delete cascade,
        pic_name text not null,
        pic_staff_id text not null,
        vehicle_search_completed boolean not null default true,
        signature_url text not null,
        signature_hash text,
        remarks text,
        completed_by uuid not null,
        completed_at timestamptz not null default now()
      );
      create table public.part_d (
        id uuid primary key default gen_random_uuid(),
        transaction_id uuid not null unique references public.transactions (id) on delete cascade,
        delivery_location text not null check (delivery_location in ('SRA_WAREHOUSE', 'AIRCRAFT')),
        receiver_name text not null,
        receiver_staff_id text not null,
        seal_intact boolean not null default true,
        signature_url text not null,
        completed_by uuid not null,
        completed_at timestamptz not null default now()
      );
      create table public.part_hub (
        id uuid primary key default gen_random_uuid(),
        transaction_id uuid not null unique references public.transactions (id) on delete cascade,
        confirmed_destination text not null check (confirmed_destination in ('PEN', 'JHB', 'NILAI')),
        hub_avsec_name text not null,
        hub_avsec_staff_id text not null,
        signature_url text not null,
        completed_by uuid not null,
        completed_at timestamptz not null default now()
      );
      create table public.part_redq (
        id uuid primary key default gen_random_uuid(),
        transaction_id uuid not null unique references public.transactions (id) on delete cascade,
        old_seal_id uuid not null,
        new_seal_id uuid not null,
        redq_avsec_name text not null,
        redq_avsec_staff_id text not null,
        signature_url text not null,
        completed_by uuid not null,
        completed_at timestamptz not null default now()
      );
    `);

    const legacyBeforeCols = {
      part_a: await columnList(client, 'part_a'),
      part_d: await columnList(client, 'part_d'),
      part_hub: await columnList(client, 'part_hub'),
      part_redq: await columnList(client, 'part_redq'),
    };

    console.log('Step 2: Seeding representative rows into the legacy tables...');
    // trg_enforce_whitelist_on_create (this harness's bootstrap of the real icms/ trigger, now
    // corrected in round 2 to re-verify real usability, not just non-null) applies to every
    // insert into public.transactions. A raw service_role insert into vehicles/drivers with no
    // created_by set bypasses the Phase 9 approval workflow entirely and lands directly on
    // status='active' -- exactly representing a pre-existing legacy row that predates the whole
    // approval concept, which is what this test is simulating in the first place.
    const myAocId = (await client.query("select id from public.aocs where code = 'MY';")).rows[0].id;
    const legacyVehicleId = (
      await client.query(
        `insert into public.vehicles (vehicle_number, is_active, aoc_id) values ('LEGACY-VEH', true, $1) returning id;`,
        [myAocId],
      )
    ).rows[0].id;
    const legacyVehicleId2 = (
      await client.query(
        `insert into public.vehicles (vehicle_number, is_active, aoc_id) values ('LEGACY-VEH-2', true, $1) returning id;`,
        [myAocId],
      )
    ).rows[0].id;
    const legacyDriverId = (
      await client.query(
        `insert into public.drivers (name, staff_id, is_active, aoc_id) values ('Legacy Driver', 'LEGACY-DRV', true, $1) returning id;`,
        [myAocId],
      )
    ).rows[0].id;
    const legacyDriverId2 = (
      await client.query(
        `insert into public.drivers (name, staff_id, is_active, aoc_id) values ('Legacy Driver 2', 'LEGACY-DRV-2', true, $1) returning id;`,
        [myAocId],
      )
    ).rows[0].id;

    // The golden template's public.profiles is empty (no fixture users created in this
    // standalone script); seed one so created_by/completed_by have a real row to reference.
    const legacyActorId = '00000000-0000-0000-0000-00000000c001';
    await client.query("insert into auth.users (id, email) values ($1, 'legacy-collision-actor@example.test') on conflict (id) do nothing;", [legacyActorId]);
    await client.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, 'legacy-collision-actor@example.test', 'Legacy Collision Actor', 'LCA-01', 'ASO', 'approved') on conflict (id) do nothing;",
      [legacyActorId],
    );

    const legacyTxId = (
      await client.query(
        `insert into public.transactions (transaction_number, direction, route, vehicle_number, driver_name, driver_id, vehicle_id, driver_id_ref, created_by)
         values ('LEGACY-TXN-1', 'OUTBOUND', 'AIRCRAFT', 'LEGACY-VEH', 'Legacy Driver', 'LEGACY-DRV', $1, $2, $3)
         returning id;`,
        [legacyVehicleId, legacyDriverId, legacyActorId],
      )
    ).rows[0].id;
    const completedBy = legacyActorId;
    await client.query(
      `insert into public.part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1, 'Legacy PIC', 'PIC-01', 'sig.png', $2);`,
      [legacyTxId, completedBy],
    );
    await client.query(
      `insert into public.part_d (transaction_id, delivery_location, receiver_name, receiver_staff_id, signature_url, completed_by) values ($1, 'AIRCRAFT', 'Legacy Receiver', 'RCV-01', 'sig.png', $2);`,
      [legacyTxId, completedBy],
    );
    const legacyTxId2 = (
      await client.query(
        `insert into public.transactions (transaction_number, direction, route, vehicle_number, driver_name, driver_id, vehicle_id, driver_id_ref, created_by)
         values ('LEGACY-TXN-2', 'OUTBOUND', 'HUB', 'LEGACY-VEH-2', 'Legacy Driver 2', 'LEGACY-DRV-2', $1, $2, $3)
         returning id;`,
        [legacyVehicleId2, legacyDriverId2, legacyActorId],
      )
    ).rows[0].id;
    await client.query(
      `insert into public.part_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, completed_by) values ($1, 'PEN', 'Legacy Hub AVSEC', 'HUB-01', 'sig.png', $2);`,
      [legacyTxId2, completedBy],
    );
    const legacySealId1 = (await client.query(`insert into public.seals (transaction_id, seal_number) values ($1, 'LEGACY-SEAL-1') returning id;`, [legacyTxId2])).rows[0].id;
    const legacySealId2 = (await client.query(`insert into public.seals (transaction_id, seal_number) values ($1, 'LEGACY-SEAL-2') returning id;`, [legacyTxId2])).rows[0].id;
    await client.query(
      `insert into public.part_redq (transaction_id, old_seal_id, new_seal_id, redq_avsec_name, redq_avsec_staff_id, signature_url, completed_by) values ($1, $2, $3, 'Legacy RedQ AVSEC', 'REDQ-01', 'sig.png', $4);`,
      [legacyTxId2, legacySealId1, legacySealId2, completedBy],
    );

    const legacyRowsBefore = {
      part_a: (await client.query('select * from public.part_a where transaction_id = $1;', [legacyTxId])).rows[0],
      part_d: (await client.query('select * from public.part_d where transaction_id = $1;', [legacyTxId])).rows[0],
      part_hub: (await client.query('select * from public.part_hub where transaction_id = $1;', [legacyTxId2])).rows[0],
      part_redq: (await client.query('select * from public.part_redq where transaction_id = $1;', [legacyTxId2])).rows[0],
    };

    console.log('Step 3: Re-applying the actual Phase 9 migration SQL against this legacy-augmented database...');
    // This clone comes from the golden template, which already ran Phase 9 once (that's how the
    // template itself was built) -- re-running the exact same SQL text a second time is this
    // test's own artifact, not a real deployment scenario (a real migration runs exactly once,
    // tracked by Supabase's migration history). `create policy` is the one statement type in
    // this file without an idempotent form (no `create policy if not exists` in Postgres), so
    // the 5 non-bootstrap-guarded policies are dropped first to let the re-apply simulate a
    // genuine first-time run -- every other object in this file (tables, functions, bootstrap-
    // guarded policies) is already naturally idempotent via IF NOT EXISTS / OR REPLACE / its own
    // existence check, so nothing else needs this treatment.
    await client.query(`
      drop policy if exists "caterlink_station_capabilities_read" on public.caterlink_station_capabilities;
      drop policy if exists "transactions_read_policy" on public.transactions;
      drop policy if exists "caterlink_incidents_read" on public.caterlink_incidents;
      drop policy if exists "caterlink_incident_notes_read" on public.caterlink_incident_notes;
      drop policy if exists "caterlink_archives_read" on public.caterlink_archives;
      drop policy if exists "catering_companies_bootstrap_read" on public.catering_companies;
      drop policy if exists "vehicles_bootstrap_read" on public.vehicles;
      drop policy if exists "drivers_bootstrap_read" on public.drivers;
    `);
    const migrationPath = path.join(__dirname, '..', '..', 'migrations', '20261001000001_phase9_caterlink_station_access.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await client.query('set check_function_bodies = off;');
    let migrationError = null;
    try {
      await client.query(migrationSql);
    } catch (e) {
      migrationError = e;
    }
    assert(migrationError === null, `Phase 9 migration re-applies cleanly with legacy part_a/part_d/part_hub/part_redq tables present (error: ${migrationError?.message ?? 'none'})`);

    console.log('Step 4: Verifying legacy table schemas are byte-for-byte unchanged...');
    for (const table of ['part_a', 'part_d', 'part_hub', 'part_redq']) {
      const afterCols = await columnList(client, table);
      assert(
        JSON.stringify(afterCols) === JSON.stringify(legacyBeforeCols[table]),
        `Legacy public.${table} column list unchanged by the Phase 9 migration (before: [${legacyBeforeCols[table].join(',')}], after: [${afterCols.join(',')}])`,
      );
    }

    console.log('Step 5: Verifying legacy seeded rows are unchanged...');
    const legacyRowsAfter = {
      part_a: (await client.query('select * from public.part_a where transaction_id = $1;', [legacyTxId])).rows[0],
      part_d: (await client.query('select * from public.part_d where transaction_id = $1;', [legacyTxId])).rows[0],
      part_hub: (await client.query('select * from public.part_hub where transaction_id = $1;', [legacyTxId2])).rows[0],
      part_redq: (await client.query('select * from public.part_redq where transaction_id = $1;', [legacyTxId2])).rows[0],
    };
    for (const table of ['part_a', 'part_d', 'part_hub', 'part_redq']) {
      assert(
        JSON.stringify(legacyRowsBefore[table]) === JSON.stringify(legacyRowsAfter[table]),
        `Legacy public.${table} seeded row is byte-for-byte unchanged after the Phase 9 migration ran`,
      );
    }

    console.log('Step 6: Verifying a plain legacy-style query still works unmodified...');
    const legacyQueryRes = await client.query(
      `select pa.pic_name, pd.receiver_name from public.part_a pa join public.part_d pd on pd.transaction_id = pa.transaction_id where pa.transaction_id = $1;`,
      [legacyTxId],
    );
    assert(legacyQueryRes.rows[0]?.pic_name === 'Legacy PIC' && legacyQueryRes.rows[0]?.receiver_name === 'Legacy Receiver', 'Legacy-style join query across part_a/part_d still returns correct data');

    console.log('Step 7: Verifying the renamed CaterLink checkpoint tables exist as entirely separate objects...');
    for (const table of ['caterlink_checkpoint_part_a', 'caterlink_checkpoint_part_d', 'caterlink_checkpoint_hub', 'caterlink_checkpoint_redq']) {
      const exists = (await client.query(`select to_regclass('public.${table}') is not null as exists;`)).rows[0].exists;
      assert(exists, `Renamed CaterLink table public.${table} exists as its own object`);
    }
    const legacyPartHubRowCount = (await client.query('select count(*)::int as n from public.part_hub;')).rows[0].n;
    const caterlinkHubRowCount = (await client.query('select count(*)::int as n from public.caterlink_checkpoint_hub;')).rows[0].n;
    assert(legacyPartHubRowCount === 1 && caterlinkHubRowCount === 0, 'Legacy part_hub (1 seeded row) and renamed caterlink_checkpoint_hub (0 rows, untouched by the re-applied migration) are genuinely separate tables, not aliases of one another');

    console.log('Step 8: Verifying no CaterLink trigger/policy attaches to any legacy-named table...');
    const legacyTriggerRows = (
      await client.query(
        `select event_object_table, trigger_name from information_schema.triggers
         where event_object_schema = 'public' and event_object_table in ('part_a', 'part_d', 'part_hub', 'part_redq')
           and trigger_name ilike '%caterlink%';`,
      )
    ).rows;
    assert(legacyTriggerRows.length === 0, `Zero CaterLink-named triggers attached to any legacy part_a/part_d/part_hub/part_redq table (found: ${JSON.stringify(legacyTriggerRows)})`);
    const legacyPolicyRows = (
      await client.query(
        `select tablename, policyname from pg_policies
         where schemaname = 'public' and tablename in ('part_a', 'part_d', 'part_hub', 'part_redq')
           and policyname ilike '%caterlink%';`,
      )
    ).rows;
    assert(legacyPolicyRows.length === 0, `Zero CaterLink-named RLS policies attached to any legacy part_a/part_d/part_hub/part_redq table (found: ${JSON.stringify(legacyPolicyRows)})`);

    console.log(`\nLegacy-collision non-regression verification completed. Total failures: ${failures}`);
  } finally {
    await client.end().catch(() => {});
    const cleanup = new Client({ ...pgConfig, database: 'postgres' });
    await cleanup.connect();
    await cleanup.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await cleanup.query(`drop database if exists ${runDb};`);
    await cleanup.end();
  }

  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('\n================================================================');
    console.log('PHASE 9 LEGACY-COLLISION NON-REGRESSION TEST COMPLETED SUCCESSFULLY!');
    console.log('================================================================');
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack);
  process.exitCode = 1;
});
