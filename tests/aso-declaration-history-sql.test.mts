import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const file = "supabase/migrations/20261130000006_repair_aso_declaration_and_history.sql";

const CURRENT_DECL_NO_ISSUE =
  "I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.";
const CURRENT_DECL_ISSUE =
  "DISCREPANCIES FOUND AND DUTY SECURITY EXECUTIVE / DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW).";
const LEGACY_DECL_NO_ISSUE =
  "I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.";
const LEGACY_DECL_ISSUE =
  "DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)";

const USER_A = "00000000-0000-0000-0000-000000000001";
const USER_B = "00000000-0000-0000-0000-000000000002";

async function setupDatabase() {
  const db = new PGlite();

  // Basic schemas and roles
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role bypassrls;

    grant usage on schema auth to public, anon, authenticated, service_role;
    grant usage on schema public to public, anon, authenticated, service_role;

    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    grant execute on function auth.uid() to public, anon, authenticated, service_role;

    create table public.profiles (
      id uuid primary key,
      name text,
      status text default 'approved'
    );

    insert into public.profiles (id, name, status) values
      ('${USER_A}', 'Officer A', 'approved'),
      ('${USER_B}', 'Officer B', 'approved');

    -- SEC029 with original legacy constraint
    create table public.report_sec029 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text,
      flight_no text,
      aircraft_registration text,
      declaration text,
      constraint report_sec029_declaration_check check (
        declaration in (
          '${LEGACY_DECL_NO_ISSUE}',
          '${LEGACY_DECL_ISSUE}'
        )
      )
    );

    -- SEC016 with time without time zone sta_std and flight_type
    create table public.report_sec016 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text,
      flight text,
      reg_no text,
      bay_no text,
      sta_std time without time zone,
      flight_type text
    );

    -- Other report tables
    create table public.report_sec013 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text
    );

    create table public.report_sec014 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text
    );

    create table public.report_sec018 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text
    );

    create table public.report_sec033 (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text
    );

    create table public.offload_records (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text,
      flight_no text,
      destination text
    );

    create table public.report_makeup (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text,
      flight_number text,
      destination text
    );

    create table public.report_breakup (
      id uuid primary key default gen_random_uuid(),
      report_no text,
      status text default 'submitted',
      submitted_at timestamptz,
      created_at timestamptz default now(),
      profile_id uuid not null,
      staff_name text,
      station text,
      team text,
      flight_number text,
      origin text
    );

    grant all on all tables in schema public to service_role;
    grant execute on all functions in schema public to service_role;

    -- Baseline functions (before migration)
    CREATE OR REPLACE FUNCTION public.report_source_summary(p_source_table text, p_source_id uuid)
     RETURNS TABLE(staff_name text, station text, team text, secondary_identifier text, reg_no text, bay_no text, sta_std text, submitter_profile_id uuid)
     LANGUAGE plpgsql
     STABLE SECURITY DEFINER
     SET search_path TO 'public'
    AS $$
    begin
      if p_source_table = 'report_sec013' then
        return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec013 t where t.id = p_source_id;
      elsif p_source_table = 'report_sec014' then
        return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec014 t where t.id = p_source_id;
      elsif p_source_table = 'report_sec016' then
        return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight, '?') || ' · Reg ' || coalesce(t.reg_no, '?')), t.reg_no, t.bay_no, t.sta_std, t.profile_id from public.report_sec016 t where t.id = p_source_id;
      elsif p_source_table = 'report_sec018' then
        return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec018 t where t.id = p_source_id;
      elsif p_source_table = 'report_sec029' then
        return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · Reg ' || coalesce(t.aircraft_registration, '?')), t.aircraft_registration, null::text, null::text, t.profile_id from public.report_sec029 t where t.id = p_source_id;
      elsif p_source_table = 'report_sec033' then
        return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec033 t where t.id = p_source_id;
      elsif p_source_table = 'offload_records' then
        return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.offload_records t where t.id = p_source_id;
      elsif p_source_table = 'report_makeup' then
        return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.report_makeup t where t.id = p_source_id;
      elsif p_source_table = 'report_breakup' then
        return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.origin, '?')), null::text, null::text, null::text, t.profile_id from public.report_breakup t where t.id = p_source_id;
      else
        raise exception 'Unsupported source_table: %', p_source_table;
      end if;
    end;
    $$;

    CREATE OR REPLACE FUNCTION public.list_my_submissions_secure(p_limit integer DEFAULT 20)
     RETURNS TABLE(id uuid, source_table text, report_no text, status text, submitted_at timestamp with time zone, created_at timestamp with time zone, staff_name text, station text, team text, secondary_identifier text)
     LANGUAGE plpgsql
     SECURITY DEFINER
     SET search_path TO 'public'
    AS $$
    declare
      v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 200);
    begin
      if auth.uid() is null then
        raise exception 'Must be signed in.';
      end if;

      return query
      with mine as (
        select 'report_sec013' as source_table, t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec013 t where t.profile_id = auth.uid()
        union all
        select 'report_sec014', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec014 t where t.profile_id = auth.uid()
        union all
        select 'report_sec016', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec016 t where t.profile_id = auth.uid()
        union all
        select 'report_sec018', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec018 t where t.profile_id = auth.uid()
        union all
        select 'report_sec029', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec029 t where t.profile_id = auth.uid()
        union all
        select 'report_sec033', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec033 t where t.profile_id = auth.uid()
        union all
        select 'offload_records', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.offload_records t where t.profile_id = auth.uid()
      )
      select
        m.id, m.source_table, m.report_no, m.status, m.submitted_at, m.created_at,
        s.staff_name, s.station, s.team, s.secondary_identifier
      from mine m
      cross join lateral public.report_source_summary(m.source_table, m.id) s
      order by m.created_at desc
      limit v_limit;
    end;
    $$;
  `);

  return db;
}

const asUser = async (db: PGlite, uid: string | null) => {
  await db.exec(
    `select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`
  );
};

test("pre-migration baseline demonstrates confirmed SEC016 type collision and SEC029 constraint failure", async () => {
  const db = await setupDatabase();
  try {
    // 1. Current SEC029 declaration fails against original check constraint
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '${CURRENT_DECL_NO_ISSUE}')`
        ),
      /check constraint|report_sec029_declaration_check/i
    );

    // 2. Pre-migration report_source_summary on SEC016 crashes due to uncast time column
    const sec016 = await db.query<{ id: string }>(
      `insert into public.report_sec016 (profile_id, sta_std, flight, reg_no) values ('${USER_A}', '12:30:00', 'AK123', '9M-AGY') returning id`
    );
    await assert.rejects(
      () =>
        db.query(
          `select * from public.report_source_summary('report_sec016', '${sec016.rows[0].id}')`
        ),
      /structure of query does not match function result type|time without time zone/i
    );
  } finally {
    await db.close();
  }
});

test("migration applies cleanly and supports both current Rev.03 and legacy SEC029 declarations while rejecting arbitrary text", async () => {
  const db = await setupDatabase();
  try {
    const migrationSql = fs.readFileSync(file, "utf8");
    await db.exec(migrationSql);

    // Legacy declarations pass
    await db.exec(
      `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '${LEGACY_DECL_NO_ISSUE}')`
    );
    await db.exec(
      `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '${LEGACY_DECL_ISSUE}')`
    );

    // Current Rev.03 declarations pass
    await db.exec(
      `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '${CURRENT_DECL_NO_ISSUE}')`
    );
    await db.exec(
      `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '${CURRENT_DECL_ISSUE}')`
    );

    // Arbitrary declaration text is rejected
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', 'ALL CHECKS OK')`
        ),
      /check constraint|report_sec029_declaration_check/i
    );

    // Empty text is rejected
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.report_sec029 (profile_id, declaration) values ('${USER_A}', '')`
        ),
      /check constraint|report_sec029_declaration_check/i
    );

    const count = await db.query<{ count: string }>(
      "select count(*)::text as count from public.report_sec029"
    );
    assert.equal(count.rows[0].count, "4", "All 4 valid declarations inserted");
  } finally {
    await db.close();
  }
});

test("report_source_summary casts SEC016 sta_std time column to text cleanly without 42804 error", async () => {
  const db = await setupDatabase();
  try {
    const migrationSql = fs.readFileSync(file, "utf8");
    await db.exec(migrationSql);

    const sec016 = await db.query<{ id: string }>(
      `insert into public.report_sec016 (profile_id, sta_std, flight, reg_no, bay_no) values ('${USER_A}', '14:45:00', 'AK456', '9M-VEC', 'B12') returning id`
    );
    const summary = await db.query<{
      secondary_identifier: string;
      reg_no: string;
      bay_no: string;
      sta_std: string;
    }>(
      `select secondary_identifier, reg_no, bay_no, sta_std from public.report_source_summary('report_sec016', '${sec016.rows[0].id}')`
    );
    assert.equal(summary.rows.length, 1);
    assert.equal(summary.rows[0].sta_std, "14:45:00");
    assert.equal(summary.rows[0].reg_no, "9M-VEC");
    assert.equal(summary.rows[0].bay_no, "B12");
    assert.equal(summary.rows[0].secondary_identifier, "Flight AK456 · Reg 9M-VEC");
  } finally {
    await db.close();
  }
});

test("list_my_submissions_secure includes makeup and breakup, preserves movement flight_type, and enforces strict caller ownership", async () => {
  const db = await setupDatabase();
  try {
    const migrationSql = fs.readFileSync(file, "utf8");
    await db.exec(migrationSql);

    // Insert records for User A
    await db.exec(`
      insert into public.report_sec016 (profile_id, report_no, flight, reg_no, sta_std, flight_type, created_at)
        values ('${USER_A}', 'SEC016-001', 'AK101', '9M-AA1', '10:00:00', 'ARRIVAL', now() - interval '4 minutes');
      insert into public.report_sec016 (profile_id, report_no, flight, reg_no, sta_std, flight_type, created_at)
        values ('${USER_A}', 'SEC016-002', 'AK102', '9M-AA2', '11:00:00', 'DEPARTURE', now() - interval '3 minutes');
      insert into public.report_makeup (profile_id, report_no, flight_number, destination, created_at)
        values ('${USER_A}', 'MKP-001', 'AK201', 'PEN', now() - interval '2 minutes');
      insert into public.report_breakup (profile_id, report_no, flight_number, origin, created_at)
        values ('${USER_A}', 'BKP-001', 'AK301', 'JHB', now() - interval '1 minute');
      insert into public.report_sec029 (profile_id, report_no, flight_no, aircraft_registration, declaration, created_at)
        values ('${USER_A}', 'SEC029-001', 'AK401', '9M-AA4', '${CURRENT_DECL_NO_ISSUE}', now());

      -- Insert record for User B (must NOT be returned to User A)
      insert into public.report_makeup (profile_id, report_no, flight_number, destination, created_at)
        values ('${USER_B}', 'MKP-USERB', 'AK999', 'BKI', now());
    `);

    // 1. Unauthenticated call fails closed
    await asUser(db, null);
    await assert.rejects(
      () => db.query("select * from public.list_my_submissions_secure(50)"),
      /Must be signed in/i
    );

    // 2. User A query
    await asUser(db, USER_A);
    const result = await db.query<{
      source_table: string;
      report_no: string;
      flight_type: string | null;
      secondary_identifier: string;
    }>("select source_table, report_no, flight_type, secondary_identifier from public.list_my_submissions_secure(50)");

    // User A sees exactly their 5 reports
    assert.equal(result.rows.length, 5);
    const reportNos = result.rows.map((r) => r.report_no);
    assert.deepEqual(reportNos, [
      "SEC029-001",
      "BKP-001",
      "MKP-001",
      "SEC016-002",
      "SEC016-001",
    ]);

    // User B's report is NOT visible to User A
    assert.ok(!reportNos.includes("MKP-USERB"));

    // Check flight_type mapping
    const sec16Arr = result.rows.find((r) => r.report_no === "SEC016-001");
    assert.equal(sec16Arr?.flight_type, "ARRIVAL");

    const sec16Dep = result.rows.find((r) => r.report_no === "SEC016-002");
    assert.equal(sec16Dep?.flight_type, "DEPARTURE");

    const mkp = result.rows.find((r) => r.report_no === "MKP-001");
    assert.equal(mkp?.source_table, "report_makeup");
    assert.equal(mkp?.flight_type, null);
    assert.equal(mkp?.secondary_identifier, "Flight AK201 · PEN");

    const bkp = result.rows.find((r) => r.report_no === "BKP-001");
    assert.equal(bkp?.source_table, "report_breakup");
    assert.equal(bkp?.flight_type, null);
    assert.equal(bkp?.secondary_identifier, "Flight AK301 · JHB");

    // 3. User B query sees only User B's report
    await asUser(db, USER_B);
    const resultB = await db.query<{ report_no: string }>(
      "select report_no from public.list_my_submissions_secure(50)"
    );
    assert.equal(resultB.rows.length, 1);
    assert.equal(resultB.rows[0].report_no, "MKP-USERB");
  } finally {
    await db.close();
  }
});

test('history RPC works as authenticated without direct table access and rejects anon', async()=>{
 const db=await setupDatabase();
 try {
  await db.exec(fs.readFileSync(file,'utf8'));
  await db.exec(`insert into public.report_makeup(profile_id,report_no) values ('${USER_A}','OWN'),('${USER_B}','OTHER')`);
  await asUser(db,USER_A);
  await db.exec('set role authenticated');
  const result=await db.query<{report_no:string}>('select report_no from public.list_my_submissions_secure(200)');
  assert.deepEqual(result.rows.map(x=>x.report_no),['OWN']);
  await assert.rejects(()=>db.query('select * from public.report_makeup'),/permission denied/i);
  await db.exec('reset role; set role anon');
  await assert.rejects(()=>db.query('select * from public.list_my_submissions_secure(200)'),/permission denied/i);
 } finally {await db.exec('reset role');await db.close();}
});
