#!/usr/bin/env node
// Recovers the DSE alerts whose delivery failed because the lookup used the station typed on the form (KUL - AAX has no CHARLIE team) instead of the
// submitter's canonical station and team. Staging only. Default is a DRY RUN that prints what would be delivered; --apply delivers, once, idempotently
// (the alert key is one per report per DSE, so a rerun adds nothing). Recipients are accepted only when they can be established safely: the report must
// be submitted, carry a canonical station and team, and the team must have at least one active DSE. Anything else is left unresolved and reported.
// Failures are identified by EXACT id from the open list (the expected number is checked first); no other report is touched.
//
// Usage: node --env-file=<staging env> scripts/staging/recover-dse-alerts.mjs --expect=8 [--apply]
import assert from "node:assert/strict";
import { connectVerified, environmentGates } from "./lib/run-gates.mjs";

const apply = process.argv.includes("--apply");
const expect = Number.parseInt(process.argv.find((a) => a.startsWith("--expect="))?.slice(9) ?? "", 10);
assert.ok(Number.isInteger(expect) && expect > 0, "--expect=<number of open failures> is required");
environmentGates();
const { client: pg } = await connectVerified();
const TABLES = new Set(["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "report_makeup", "report_breakup"]);
try {
  const open = (await pg.query("select id, source_table, source_id, created_at from public.report_notification_failures where resolved_at is null order by created_at, id")).rows;
  console.log(`open delivery failures: ${open.length} (expected ${expect})`);
  assert.equal(open.length, expect, "The number of open failures is not what was reviewed; stopping without changes.");
  let recovered = 0, left = 0, alerts = 0;
  await pg.query("begin");
  try {
    for (const f of open) {
      assert.ok(TABLES.has(f.source_table), `unsupported table ${f.source_table}`);
      const r = (await pg.query(`select t.id, lower(t.status::text) status, t.report_no, t.profile_id, t.org_station_id, t.org_team_id, st.code station, tm.name team, t.station typed_station,
          ${f.source_table === "report_sec016" ? "t.flight" : f.source_table === "report_sec029" ? "t.flight_no" : f.source_table === "report_makeup" || f.source_table === "report_breakup" ? "t.flight_number" : "null::text"} flight
        from public.${f.source_table} t left join public.org_stations st on st.id=t.org_station_id left join public.org_teams tm on tm.id=t.org_team_id where t.id=$1`, [f.source_id])).rows[0];
      const recipients = r && r.status === "submitted" && r.org_station_id && r.org_team_id ? (await pg.query("select profile_id from public.dse_scope_recipients($1,$2,$3)", [r.org_station_id, r.org_team_id, r.profile_id])).rows.map((x) => x.profile_id) : [];
      const label = `${f.source_table} ${r?.report_no ?? f.source_id} typed "${r?.typed_station}" -> ${r?.station}/${r?.team}`;
      if (recipients.length === 0) { left += 1; console.log(`LEFT UNRESOLVED (recipients cannot be established safely): ${label}`); continue; }
      console.log(`${apply ? "RECOVER" : "WOULD RECOVER"}: ${label} -> ${recipients.length} DSE(s)`);
      if (apply) {
        const n = (await pg.query("select public.deliver_dse_report_notifications_v2($1,$2,$3,$4) n", [f.source_table, f.source_id, r.report_no, r.flight])).rows[0].n;
        alerts += n;
        // a delivery that failed again would have written a NEW failure row: do not resolve the old one in that case
        const again = (await pg.query("select count(*)::int n from public.report_notification_failures where source_id=$1 and resolved_at is null and id<>$2", [f.source_id, f.id])).rows[0].n;
        if (again > 0) { left += 1; console.log("  delivery failed again; left unresolved"); continue; }
        await pg.query("update public.report_notification_failures set resolved_at = now() where id = $1 and resolved_at is null", [f.id]);
      }
      recovered += 1;
    }
    if (apply) await pg.query("commit"); else await pg.query("rollback");
  } catch (e) { await pg.query("rollback"); throw e; }
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${recovered} recoverable, ${left} left unresolved, ${alerts} alert(s) offered. Open failures now: ${(await pg.query("select count(*)::int n from public.report_notification_failures where resolved_at is null")).rows[0].n}`);
} finally { await pg.end(); }
