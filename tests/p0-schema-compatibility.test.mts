import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const migrations = {
  reports: fs.readFileSync("supabase/migrations/20261118000001_p0_report_schema_compatibility.sql", "utf8"),
  duty: fs.readFileSync("supabase/migrations/20261118000002_p0_duty_overtime_compatibility.sql", "utf8"),
  profiles: fs.readFileSync("supabase/migrations/20261118000003_p0_profile_approval_audit.sql", "utf8"),
};

test("report compatibility migration accepts current report payload fields and SEC014 Apron entries beyond 15", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table report_sec013 (id uuid primary key);
      create table report_sec014 (id uuid primary key);
      create table report_sec016 (id uuid primary key, ops_group text);
      create table report_sec018 (id uuid primary key);
      create table report_sec029 (id uuid primary key);
      create table report_sec033 (id uuid primary key);
      create table report_sec014_patrols (
        id uuid primary key,
        entry_no integer not null constraint report_sec014_patrols_entry_no_check check (entry_no between 1 and 15),
        location text not null constraint report_sec014_patrols_location_check check (location = any (array['Aircraft','Terminal','Premises']))
      );
    `);

    await assert.rejects(
      db.query("insert into report_sec029 (id, ops_group, aircraft_type_other, flight_destination) values ('00000000-0000-0000-0000-000000000001', null, 'Sample', 'KUL')"),
      /column .* does not exist/i,
    );

    await db.exec(migrations.reports);
    await db.exec(migrations.reports);

    for (const table of ["report_sec013", "report_sec014", "report_sec018", "report_sec029", "report_sec033"]) {
      await db.query(`insert into ${table} (id, ops_group) values (gen_random_uuid(), null)`);
    }
    await db.query("insert into report_sec029 (id, aircraft_type_other, flight_destination) values (gen_random_uuid(), 'Sample', 'KUL')");
    await db.query("insert into report_sec014_patrols (id, entry_no, location) values (gen_random_uuid(), 16, 'Apron')");
  } finally {
    await db.close();
  }
});

test("duty compatibility migration accepts current check-in and automatic overtime payloads idempotently", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table duty_records (id uuid primary key);
      create table overtime_requests (
        id uuid primary key,
        linked_duty_id uuid,
        category text not null constraint overtime_requests_category_check
          check (category = any (array['flight_delay','manpower_shortage','event','off_day_work','adhoc']))
      );
    `);

    await assert.rejects(
      db.query("insert into duty_records (id, ops_group) values ('00000000-0000-0000-0000-000000000010', null)"),
      /column .* does not exist/i,
    );

    await db.exec(migrations.duty);
    await db.exec(migrations.duty);

    const dutyId = "00000000-0000-0000-0000-000000000010";
    await db.query("insert into duty_records (id, ops_group) values ($1, null)", [dutyId]);
    await db.query(`
      insert into overtime_requests
        (id, linked_duty_id, category, ops_group, actual_check_in, actual_check_out, scheduled_start, scheduled_end)
      values
        ('00000000-0000-0000-0000-000000000011', $1, 'early_arrival', null, now(), now(), now(), now())
      on conflict (linked_duty_id, category) do nothing
    `, [dutyId]);
    await db.query(`
      insert into overtime_requests (id, linked_duty_id, category)
      values ('00000000-0000-0000-0000-000000000012', $1, 'early_arrival')
      on conflict (linked_duty_id, category) do nothing
    `, [dutyId]);
    await db.query(`
      insert into overtime_requests
        (id, linked_duty_id, category, ops_group, actual_check_in, actual_check_out, scheduled_start, scheduled_end)
      values
        ('00000000-0000-0000-0000-000000000013', $1, 'late_departure', null, now(), now(), now(), now())
      on conflict (linked_duty_id, category) do nothing
    `, [dutyId]);
    const rows = await db.query<{ count: string }>("select count(*)::text as count from overtime_requests");
    assert.equal(rows.rows[0].count, "2");
  } finally {
    await db.close();
  }
});

test("profile compatibility migration records approval and rejection audit data without adding role-authority columns", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table profiles (id uuid primary key, status text not null);");
    await assert.rejects(
      db.query("update profiles set approved_at = now()"),
      /column .* does not exist/i,
    );

    await db.exec(migrations.profiles);
    await db.exec(migrations.profiles);

    const managerId = "00000000-0000-0000-0000-000000000020";
    const staffId = "00000000-0000-0000-0000-000000000021";
    await db.query("insert into profiles (id, status) values ($1, 'approved'), ($2, 'pending')", [managerId, staffId]);
    await db.query("update profiles set status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = 'Scope mismatch' where id = $2", [managerId, staffId]);
    const row = await db.query<{ status: string; approved_by: string; rejection_reason: string }>(
      "select status, approved_by::text, rejection_reason from profiles where id = $1",
      [staffId],
    );
    assert.deepEqual(row.rows[0], { status: "rejected", approved_by: managerId, rejection_reason: "Scope mismatch" });

    const legacy = await db.query<{ count: string }>(`
      select count(*)::text as count
      from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name in ('unified_role', 'org_id', 'duty_post', 'ops_group')
    `);
    assert.equal(legacy.rows[0].count, "0");
  } finally {
    await db.close();
  }
});

const sec014Stub = `
  create table report_sec013 (id uuid primary key);
  create table report_sec014 (id uuid primary key);
  create table report_sec018 (id uuid primary key);
  create table report_sec029 (id uuid primary key);
  create table report_sec033 (id uuid primary key);
`;
const overtimeStub = (extra = "") => `
  create table duty_records (id uuid primary key);
  create table overtime_requests (
    id uuid primary key,
    linked_duty_id uuid,
    category text not null constraint overtime_requests_category_check
      check (category = any (array['flight_delay','manpower_shortage','event','off_day_work','adhoc']))
  );
  ${extra}
`;
const DUTY = "00000000-0000-0000-0000-000000000030";

test("the new constraints still reject out-of-range values (a dropped-and-not-re-added check would fail this)", async () => {
  const db = new PGlite();
  try {
    await db.exec(`${sec014Stub}
      create table report_sec014_patrols (id uuid primary key default gen_random_uuid(), entry_no integer not null, location text not null);`);
    await db.exec(migrations.reports);
    await assert.rejects(db.query("insert into report_sec014_patrols (entry_no, location) values (0, 'Apron')"), /report_sec014_patrols_entry_no_check/);
    await assert.rejects(db.query("insert into report_sec014_patrols (entry_no, location) values (1, 'Garage')"), /report_sec014_patrols_location_check/);
    await db.exec(overtimeStub());
    await db.exec(migrations.duty);
    await assert.rejects(db.query("insert into overtime_requests (id, linked_duty_id, category) values (gen_random_uuid(), gen_random_uuid(), 'bogus')"), /overtime_requests_category_check/);
  } finally {
    await db.close();
  }
});

test("an old CHECK with a different name does not survive: exactly one check per constrained column and Apron entry 16 is accepted", async () => {
  const db = new PGlite();
  try {
    await db.exec(`${sec014Stub}
      create table report_sec014_patrols (
        id uuid primary key default gen_random_uuid(),
        entry_no integer not null constraint legacy_entry_cap check (entry_no between 1 and 15),
        location text not null constraint legacy_location_set check (location = any (array['Aircraft','Terminal','Premises']))
      );`);
    await db.exec(migrations.reports);
    await db.query("insert into report_sec014_patrols (entry_no, location) values (16, 'Apron')");
    const checks = await db.query<{ n: string }>("select count(*)::text n from pg_constraint where conrelid = 'report_sec014_patrols'::regclass and contype = 'c'");
    assert.equal(checks.rows[0].n, "2");
  } finally {
    await db.close();
  }
});

test("duplicate (linked_duty_id, category) rows abort the duty migration with a clear message and leave the table unchanged", async () => {
  const db = new PGlite();
  try {
    await db.exec(overtimeStub(`
      insert into overtime_requests (id, linked_duty_id, category) values
        (gen_random_uuid(), '${DUTY}', 'off_day_work'), (gen_random_uuid(), '${DUTY}', 'off_day_work');`));
    await assert.rejects(db.exec(migrations.duty), /duplicate .*overtime_requests.*linked_duty_id.*category/i);
    const cols = await db.query<{ n: string }>("select count(*)::text n from information_schema.columns where table_name = 'overtime_requests' and column_name = 'calculated_at'");
    assert.equal(cols.rows[0].n, "0");
  } finally {
    await db.close();
  }
});

test("a same-named but partial unique index is refused (it would not satisfy the upsert contract)", async () => {
  const db = new PGlite();
  try {
    await db.exec(overtimeStub(`create unique index overtime_requests_duty_category_uniq on overtime_requests (linked_duty_id, category) where category = 'adhoc';`));
    await assert.rejects(db.exec(migrations.duty), /overtime_requests_duty_category_uniq/);
  } finally {
    await db.close();
  }
});

test("the P0 migrations contain no policy, grant, function, trigger, storage, delete or legacy-authority statements", () => {
  const forbidden = /\b(create|alter|drop)\s+(or\s+replace\s+)?(policy|function|procedure|trigger|publication|role|schema|extension)\b|^\s*(grant|revoke|truncate|delete|insert|update)\b|\bstorage\.|\bdrop\s+table\b|\badd\s+column\s+(if\s+not\s+exists\s+)?(org_id|unified_role|duty_post)\b/im;
  for (const [name, sql] of Object.entries(migrations)) {
    const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(code, forbidden, name);
  }
});
