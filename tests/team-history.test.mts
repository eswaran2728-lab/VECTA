import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTeamHistoryFilters, teamHistoryRpcArgs, teamHistoryHref, TEAM_HISTORY_TYPES, TEAM_HISTORY_PAGE_SIZE } from "../lib/avsec/reports/team-history-filters.ts";

const sql = fs.readFileSync("supabase/migrations/20261205000001_report_canonical_scope_and_team_history.sql", "utf8");
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} defined`);
  return sql.slice(start, sql.indexOf("$function$;", sql.indexOf("$function$", start) + 10) + 11);
};

test("the active security report types are exactly the eight, with no retired Offload", () => {
  assert.deepEqual([...TEAM_HISTORY_TYPES], ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "makeup", "breakup"]);
});

test("filters: defaults, normalisation and rejection of anything unexpected", () => {
  const d = parseTeamHistoryFilters({});
  assert.deepEqual(d, { type: null, from: null, to: null, entity: null, search: null, flight: null, ack: null, page: 1 });
  const f = parseTeamHistoryFilters({ type: "SEC016", entity: "aax", ack: "Pending", q: "  Ali_%  ", flight: "ak5001", from: "2026-11-04", to: "2026-11-01", page: "3" });
  assert.equal(f.type, "sec016");
  assert.equal(f.entity, "AAX");
  assert.equal(f.ack, "pending");
  assert.equal(f.search, "Ali", "wildcard characters are stripped, not passed to the database");
  assert.equal(f.flight, "ak5001");
  assert.deepEqual([f.from, f.to], ["2026-11-01", "2026-11-04"], "a reversed range is put in order");
  assert.equal(f.page, 3);
  const bad = parseTeamHistoryFilters({ type: "offload", entity: "ZZ", ack: "all", from: "2026-13-45", page: "-4" });
  assert.deepEqual([bad.type, bad.entity, bad.ack, bad.from, bad.page], [null, null, null, null, 1], "the retired Offload type and impossible values are ignored");
  assert.equal(parseTeamHistoryFilters({ page: "999999" }).page, 10000);
  assert.equal(parseTeamHistoryFilters({ type: ["sec014", "sec016"] }).type, "sec014");
});

test("RPC arguments page by 25 and carry no station or team (scope is never a client input)", () => {
  const args = teamHistoryRpcArgs(parseTeamHistoryFilters({ page: "2", entity: "MAA" }));
  assert.equal(args.p_limit, TEAM_HISTORY_PAGE_SIZE);
  assert.equal(args.p_offset, TEAM_HISTORY_PAGE_SIZE);
  assert.equal(args.p_entity, "MAA");
  assert.ok(!Object.keys(args).some((k) => /station|team|profile/.test(k)));
});

test("filter URLs round-trip and omit defaults", () => {
  assert.equal(teamHistoryHref(parseTeamHistoryFilters({})), "/avsec/history/team");
  const f = parseTeamHistoryFilters({ type: "sec014", entity: "MAA", page: "2" });
  assert.equal(teamHistoryHref(f, { page: 3 }), "/avsec/history/team?type=sec014&entity=MAA&page=3");
});

test("the list function scopes to the caller's own DSE or SO station and team, on the report's canonical scope, for both entities", () => {
  const f = fn("list_team_submissions_secure");
  assert.match(f, /a\.role_code in \('dse', 'so'\)/);
  assert.match(f, /c\.station_code = s\.canon_station and c\.team_upper = upper\(coalesce\(s\.canon_team, ''\)\)/);
  assert.match(f, /coalesce\(os\.code, x\.typed\) as canon_station/);
  assert.doesNotMatch(f, /p_station|p_team\b/, "scope is not a parameter");
  assert.doesNotMatch(f, /operating_entity_code\s*=\s*\(/, "the caller's entity does not limit the list");
  assert.match(f, /Team Submission History is available to a DSE or SO/);
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "report_makeup", "report_breakup"]) assert.match(f, new RegExp(`public\\.${t} t`), t);
  assert.doesNotMatch(f, /offload/);
});

test("acknowledgment, visibility and alerts read the canonical scope, not the typed station", () => {
  assert.match(fn("get_report_submitter"), /report_canonical_scope/);
  assert.match(fn("report_canonical_scope"), /coalesce\(st\.code, t\.station\)/);
  assert.match(fn("can_acknowledge_report"), /canon_dse_of_team\(sub\.station, sub\.team\) and v_sub in \(1, 2\)/);
  const d = fn("dse_scope_recipients");
  assert.match(d, /ura\.station_id = p_station_id/);
  assert.match(d, /ura\.team_id = p_team_id/);
  assert.doesNotMatch(d, /entity|membership/i, "a DSE is one role per station and team: no entity condition");
  assert.match(fn("notify_dse_of_report"), /deliver_dse_report_notifications_v2/);
});

test("alerts are idempotent per report and DSE, and a failure is recorded, never raised", () => {
  const v = fn("deliver_dse_report_notifications_v2");
  assert.match(v, /'dse_report:' \|\| p_source_table \|\| ':' \|\| p_source_id::text \|\| ':' \|\| r\.profile_id::text/);
  assert.match(v, /insert into public\.report_notification_failures/);
  assert.match(v, /exception when others then/);
});

test("new reports cannot carry a station or team different from the submitter's assignment; imports and the SEC029 KUL collapse are allowed", () => {
  const e = fn("enforce_report_operational_scope");
  assert.match(e, /auth\.uid\(\) is null or auth\.role\(\) = 'service_role'/);
  assert.match(e, /report station must be your assigned station/);
  assert.match(e, /report team must be your assigned team/);
  assert.match(e, /tg_table_name = 'report_sec029' and \(j ->> 'station'\) = 'KUL'/);
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "report_makeup", "report_breakup"]) {
    assert.match(sql, new RegExp(`create trigger trg_zz_enforce_report_operational_scope before insert on public\\.${t} `), t);
  }
});

test("exactly one audit record per acknowledgment, from a trigger on the acknowledgment table", () => {
  assert.match(fn("audit_report_acknowledgement"), /phase8_write_audit\('report_acknowledged'/);
  assert.match(sql, /create trigger trg_audit_report_acknowledgement after insert on public\.report_acknowledgements/);
});

test("the Team Submission History page is DSE/SO only, keeps My Submission History, and lists the required columns", () => {
  const page = fs.readFileSync("app/(avsec)/avsec/history/team/page.tsx", "utf8");
  assert.match(page, /roles\.includes\("dse"\) \|\| !roles\.includes\("so"\)|!roles\.includes\("dse"\) && !roles\.includes\("so"\)/);
  for (const col of ["Report", "Type", "Officer", "Staff ID", "Flight", "Entity", "Station · Team", "Submitted", "Status", "Acknowledgment"]) assert.match(page, new RegExp(`>${col}<`), col);
  assert.match(page, /md:hidden/, "a card list for phones");
  assert.match(page, /hidden overflow-x-auto md:block/, "a table for larger screens");
  const history = fs.readFileSync("app/(avsec)/avsec/history/page.tsx", "utf8");
  assert.match(history, /My Submission History/);
  assert.match(history, /Team Submission History/);
});
