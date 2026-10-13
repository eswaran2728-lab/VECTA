// Shared, database-clock based helpers for the tagged UAT duty fixtures (staging only; used by uat-fixtures.mjs, uat-preflight.mjs and
// hosted-uat.mjs). Time always comes from the STAGING DATABASE, never from the local machine (which may sleep, drift or change zone).

/** Every rostered review account that has a station (hub_se has none and is not duty-gated). The ONLY accounts duty fixtures may touch. */
export const DUTY_LABELS = [
  "sat_aso", "profiling_so", "profiling_aso", "dse", "sso", "so", "aso", "sso-kul", "so-kul", "aso-kul",
  "sso-jhb", "so-jhb", "aso-jhb", "aso-no-caterlink", "aso-kch-receipt", "aso-bki-receipt",
];

/** The database's now(), the Malaysia operational date (what the application's duty gate calls "today") and the seconds left in it. */
export async function dbClock(client) {
  const r = (await client.query(`
    select now()::text as now_utc,
           (now() at time zone 'Asia/Kuala_Lumpur')::date::text as my_date,
           extract(epoch from (date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur') + interval '1 day') - (now() at time zone 'Asia/Kuala_Lumpur'))::int as seconds_left`)).rows[0];
  return { nowUtc: r.now_utc, myDate: r.my_date, secondsLeft: r.seconds_left };
}

/**
 * Evaluates the duty gate's own predicate for each fixture account, AS THAT USER under RLS (the same visibility the application has):
 * an open check-in dated "today (Malaysia)" -- check_in_at set, check_out_at null (lib/avsec/duty/checkin-queries.ts: hasOpenDutyCheckIn).
 * Returns the labels that are NOT active. Runs inside a rolled-back transaction.
 */
export async function inactiveDutyLabels(client, entries, manifest) {
  const bad = [];
  for (const e of entries) {
    const uid = manifest.find((a) => a.label === e.label)?.authUserId;
    await client.query("BEGIN");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      const r = await client.query(
        `select id from public.duty_records
         where profile_id = $1 and duty_date = (now() at time zone 'Asia/Kuala_Lumpur')::date and check_in_at is not null and check_out_at is null`,
        [uid],
      );
      if (r.rowCount < 1) bad.push(e.label);
    } finally {
      await client.query("ROLLBACK");
    }
  }
  return bad;
}
