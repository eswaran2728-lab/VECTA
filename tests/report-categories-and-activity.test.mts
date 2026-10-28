import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLE_CAPABILITIES, canCreateReport } from "../lib/auth/role-capabilities.ts";
import { REPORT_CATEGORIES, groupAllowedReportForms, reportDisplayTitle } from "../lib/avsec/reports/report-categories.ts";
import { buildPersonalActivity, buildStationActivity, transactionStations } from "../lib/avsec/dashboard/activity.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------------------------------------------------
// 1. Report categories
// ---------------------------------------------------------------------------------------------------------------------

const ALL = ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033"];

test("categories: Daily, Aircraft, Makeup and Breakup membership and order are exactly the approved grouping", () => {
  assert.deepEqual(
    REPORT_CATEGORIES.map((c) => [c.title, [...c.forms]]),
    [
      ["Daily Reports", ["sec014", "sec013"]],
      ["Aircraft Reports", ["sec016", "sec029", "sec018", "sec033"]],
      ["Makeup Report", ["makeup"]],
      ["Breakup Report", ["breakup"]],
    ],
  );
  const grouped = groupAllowedReportForms(ALL);
  assert.deepEqual(
    grouped.flatMap((g) => g.forms.map((f) => `${f.code} — ${f.title}`)),
    [
      "AA/SEC/F/014 Rev.03 — ASO Daily Report",
      "AA/SEC/F/013 Rev.03 — Daily Report Profiling",
      "AA/SEC/F/016 Rev.03 — ASO Attending Flight Report",
      "AA/SEC/F/029 Rev.03 — Aircraft Search Checklist",
      "AA/SEC/F/018 Rev.01 — Aircraft Security Patrol and Guarding Duty Log",
      "AA/SEC/F/033 Rev.02 — Aircraft Hold Checklist",
    ],
  );
  // existing form routes are unchanged
  assert.deepEqual(grouped.flatMap((g) => g.forms.map((f) => f.href)), ["/avsec/reports/sec014", "/avsec/reports/sec013", "/avsec/reports/sec016", "/avsec/reports/sec029", "/avsec/reports/sec018", "/avsec/reports/sec033"]);
  assert.equal(reportDisplayTitle("sec018"), "Aircraft Security Patrol and Guarding Duty Log");
});

test("categories: ordinary ASO sees Daily (SEC014 only), the four Aircraft forms, Makeup and Breakup; SEC013 is NOT shown just because it is a Daily Report", () => {
  const aso = groupAllowedReportForms(ROLE_CAPABILITIES.aso.reportForms);
  assert.deepEqual(aso.map((g) => [g.id, g.forms.map((f) => f.type)]), [
    ["daily", ["sec014"]],
    ["aircraft", ["sec016", "sec029", "sec018", "sec033"]],
    ["makeup", ["makeup"]],
    ["breakup", ["breakup"]],
  ]);
});

test("categories: Profiling ASO sees only Daily Reports with SEC013; the empty Aircraft category is hidden", () => {
  const p = groupAllowedReportForms(ROLE_CAPABILITIES.profiling_aso.reportForms);
  assert.deepEqual(p.map((g) => [g.id, g.forms.map((f) => f.type)]), [["daily", ["sec013"]]]);
});

test("categories: a caller with no assigned forms (SO, DSE, leadership) gets no categories at all", () => {
  assert.deepEqual(groupAllowedReportForms([]), []);
  for (const role of ["so", "sso", "dse", "hub_se", "operation_manager", "main_enforcement", "ghod"]) {
    assert.deepEqual(groupAllowedReportForms(ROLE_CAPABILITIES[role].reportForms), [], role);
  }
});

test("categories: the retired standalone Offload is never offered, even if a stale assignment list still contains it", () => {
  const g = groupAllowedReportForms([...ALL, "offload"]);
  assert.ok(!g.flatMap((x) => x.forms.map((f) => f.type as string)).includes("offload"));
  assert.ok(!JSON.stringify(g).toLowerCase().includes("offload"));
});

test("categories: per-station visibility follows the database list, the grouping adds nothing", () => {
  // KUL-assigned ASO has all five; a station with only SEC014 assigned shows Daily only.
  assert.deepEqual(groupAllowedReportForms(["sec014"]).map((g) => g.id), ["daily"]);
  assert.deepEqual(groupAllowedReportForms(["sec029", "sec033"]).map((g) => [g.id, g.forms.length]), [["aircraft", 2]]);
});

test("Makeup and Breakup reports are active: separate categories, routes and metadata exist", () => {
  assert.equal(reportDisplayTitle("makeup"), "Makeup Report");
  assert.equal(reportDisplayTitle("breakup"), "Breakup Report");
  const makeupCat = REPORT_CATEGORIES.find((c) => c.id === "makeup");
  const breakupCat = REPORT_CATEGORIES.find((c) => c.id === "breakup");
  assert.ok(makeupCat && makeupCat.forms.includes("makeup"));
  assert.ok(breakupCat && breakupCat.forms.includes("breakup"));
});

test("landing and ASO home render the grouped component from the DATABASE form list, not a role constant", () => {
  const landing = read("app/page.tsx");
  assert.match(landing, /getAllowedReportForms\(\)/);
  assert.match(landing, /<ReportCategoryGroups allowed=\{allowedForms\} layout="grid" \/>/);
  assert.doesNotMatch(landing, /requiresDailyReport|permittedAvsecReports/);
  assert.match(landing, /href="\/avsec\/history"/, "History stays accessible");
  const home = read("app/(avsec)/avsec/home/page.tsx");
  assert.match(home, /getAllowedReportForms\(\)/);
  assert.match(home, /<ReportCategoryGroups allowed=\{allowedForms\} layout="list" \/>/);
  assert.match(home, /href="\/avsec\/history"/);
  assert.doesNotMatch(home, /REPORT_ORDER/);
});

test("category component: hides empty categories, theme tokens only (light/dark/device), phone-first single column", () => {
  const c = read("components/avsec/reports/ReportCategoryGroups.tsx");
  assert.match(c, /groupAllowedReportForms\(allowed\)/);
  assert.match(c, /grid-cols-1 gap-2 min-\[420px\]:grid-cols-2/);
  assert.match(c, /min-h-\[56px\]/, "touch target");
  assert.doesNotMatch(c, /\b(bg|text|border)-(white|black|gray|slate|zinc|neutral)\b|#[0-9a-fA-F]{3,8}\b/, "no hard-coded colours: appearance follows the theme tokens");
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Offload retired as a standalone report; SEC016 departure offload and history preserved
// ---------------------------------------------------------------------------------------------------------------------

test("offload: no role can create it, the server action refuses, the link redirects to SEC016", () => {
  for (const [code, cap] of Object.entries(ROLE_CAPABILITIES)) assert.ok(!(cap.reportForms as readonly string[]).includes("offload"), code);
  assert.equal(canCreateReport(["aso"], "offload"), false);
  const actions = read("lib/avsec/reports/actions.ts");
  const body = actions.slice(actions.indexOf("export async function submitOffload"), actions.indexOf("// ---------- Bay Board"));
  assert.doesNotMatch(body, /\.from\("offload_records"\)|\.insert\(|requireProfileId|createClient/, "the retired action performs no read, guard or write");
  assert.match(read("app/(avsec)/avsec/reports/offload/page.tsx"), /redirect\("\/avsec\/reports\/sec016"\)/);
});

test("offload migration: closes creation at the database; nothing historical is dropped, deleted or rewritten", () => {
  const sql = read("supabase/migrations/20261127000001_retire_standalone_offload_report.sql");
  assert.match(sql, /select p_form <> 'offload'\s+and exists/);
  assert.match(sql, /array\['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013'\]/);
  assert.match(sql, /update public\.report_form_assignments\s+set revoked_at = now\(\)\s+where form_type = 'offload'\s+and revoked_at is null;/);
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\b(drop|truncate|delete\s+from|alter\s+table)\b/i);
  assert.doesNotMatch(code, /offload_records|offload_items/, "historical tables are not referenced, so they cannot be touched");
  // the trigger that refuses a standalone insert still keys off can_create_report_form('offload')
  const wc = read("supabase/migrations/20261103000001_role_workspace_completion.sql");
  assert.match(wc, /when 'offload_records' then 'offload'/);
  assert.match(wc, /not public\.can_create_report_form\(v_form\)/);
});

test("SEC016 departure Offload Information section keeps its fields and validation", () => {
  const schema = read("lib/avsec/schemas/sec016.ts");
  const form = read("components/avsec/forms/Sec016Form.tsx");
  for (const f of ["offload_baggage_tag_no", "offload_remark"]) {
    assert.match(schema, new RegExp(f), `schema ${f}`);
    assert.match(form, new RegExp(f), `form ${f}`);
  }
  assert.match(read("lib/avsec/reports/actions.ts"), /offload_baggage_tag_no: v\.offload_baggage_tag_no \|\| null/);
});

test("historical Offload records stay readable and exportable (viewer, filters, PDF component, search all still reference them)", () => {
  assert.match(read("lib/dashboard/entity-report-filters.ts"), /offload_records/);
  assert.match(read("lib/avsec/reference-data.ts"), /table: "offload_records"/);
  assert.ok(fs.existsSync(path.join(ROOT, "lib/avsec/export/pdf/OffloadPdf.tsx")));
  assert.match(read("lib/avsec/search/enforcementSearch.ts"), /"offload"/);
  assert.match(read("lib/avsec/reports/actions.ts"), /offload: "offload_records"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. My Recent Activity vs Station Activity
// ---------------------------------------------------------------------------------------------------------------------

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

test("personal activity: only the signed-in officer's own actions, with each action's own timestamp", () => {
  const rows = buildPersonalActivity(ME, {
    duty: [
      { profile_id: ME, check_in_at: "2026-10-27T00:05:00Z", check_out_at: "2026-10-27T10:00:00Z" },
      { profile_id: OTHER, check_in_at: "2026-10-27T00:10:00Z", check_out_at: null },
    ],
    submissions: [
      { id: "r1", type: "sec014", submitted_at: "2026-10-27T09:30:00Z", summary: "Team A", report_no: "AASEC14-20261027-0001", status: "submitted" },
      { id: "r2", type: "sec016", submitted_at: null, summary: "draft", status: "draft" },
    ],
    checkpoints: [
      { kind: "part_b", id: "c1", completed_by: ME, completed_at: "2026-10-27T03:00:00Z", result: "PASS", transaction_number: "CL-2026-000001" },
      { kind: "part_b", id: "c2", completed_by: OTHER, completed_at: "2026-10-27T03:30:00Z", result: "PASS", transaction_number: "CL-2026-000002" },
      { kind: "receipt", id: "c3", completed_by: ME, completed_at: "2026-10-27T05:00:00Z", transaction_number: "CL-2026-000003" },
      { kind: "part_b", id: "c4", completed_by: ME, completed_at: "2026-10-27T06:00:00Z", result: "ESCALATE", transaction_number: "CL-2026-000004" },
    ],
  });
  const keys = rows.map((r) => r.key);
  assert.ok(!keys.some((k) => k.includes("c2")), "somebody else's checkpoint is not mine");
  assert.equal(rows.filter((r) => r.activity.startsWith("Checked")).length, 2, "my own check-in and check-out; the other officer's check-in is excluded");
  assert.deepEqual(rows.map((r) => r.time), ["2026-10-27T10:00:00Z", "2026-10-27T09:30:00Z", "2026-10-27T06:00:00Z", "2026-10-27T05:00:00Z", "2026-10-27T03:00:00Z", "2026-10-27T00:05:00Z"]);
  assert.ok(!rows.some((r) => r.key.includes("sec016")), "a draft is not a submission");
  const byTx = Object.fromEntries(rows.filter((r) => r.reference).map((r) => [r.reference, r]));
  assert.equal(byTx["CL-2026-000003"].activity, "Confirmed destination receipt");
  assert.equal(byTx["CL-2026-000004"].status, "ESCALATED");
  assert.match(byTx["AASEC14-20261027-0001"].activity, /^Submitted AA\/SEC\/F\/014 Rev\.03/);
});

test("personal activity: a broad / mis-scoped input can never show another user's action as mine; empty evidence yields an empty feed", () => {
  assert.deepEqual(buildPersonalActivity(ME, { duty: [{ profile_id: OTHER, check_in_at: "2026-10-27T00:00:00Z", check_out_at: null }], submissions: [], checkpoints: [{ kind: "part_c", id: "x", completed_by: OTHER, completed_at: "2026-10-27T01:00:00Z", transaction_number: "T" }] }), []);
  assert.deepEqual(buildPersonalActivity(ME, { duty: [], submissions: [], checkpoints: [] }), []);
  assert.deepEqual(buildPersonalActivity(ME, { duty: [{ profile_id: ME, check_in_at: null, check_out_at: null }], submissions: [], checkpoints: [] }), [], "no timestamp means no invented action");
});

test("personal activity queries are scoped in the query itself (actor column = authenticated user), never read the audit log", () => {
  const q = read("lib/avsec/dashboard/activity-queries.ts");
  const personal = q.slice(q.indexOf("export async function getMyRecentActivity"), q.indexOf("export async function getStationActivity"));
  assert.match(personal, /\.eq\("profile_id", userId\)/);
  assert.match(personal, /\.eq\("completed_by" as never, userId as never\)/);
  assert.match(personal, /getMySubmissions\(\{ profileId: userId/);
  assert.doesNotMatch(q, /\.from\("[a-z_]*audit/i, "no audit-table access is added");
  assert.match(read("app/page.tsx"), /getMyRecentActivity\(user\.id\)/, "the actor is the authenticated user id, not request input");
});

const tx = (o: Partial<Parameters<typeof buildStationActivity>[1]["transactions"][number]>) => ({
  transaction_number: "CL-2026-000010", status: "CREATED", direction: "OUTBOUND", route: "HUB", station: "KUL", hub_destination: "PEN",
  origin_station_code: "KUL", destination_station_code: "PEN", created_at: "2026-10-27T02:00:00Z", completed_at: null, ...o,
});

test("station activity: only the officer's own station; another station's records never mix in", () => {
  const rows = buildStationActivity("PEN", {
    duty: [
      { check_in_at: "2026-10-27T00:00:00Z", check_out_at: null, profiles: { name: "A One", station: "PEN" } },
      { check_in_at: "2026-10-27T00:01:00Z", check_out_at: null, profiles: { name: "B Two", station: "JHB" } },
    ],
    transactions: [
      tx({ transaction_number: "CL-1", station: "KUL", hub_destination: "PEN" }),
      tx({ transaction_number: "CL-2", station: "JHB", hub_destination: "JHB", origin_station_code: "JHB", destination_station_code: "JHB" }),
      tx({ transaction_number: "CL-3", station: null, hub_destination: null, origin_station_code: null, destination_station_code: "PEN" }),
    ],
    submissions: [
      { id: "s1", type: "sec014", submitted_at: "2026-10-27T08:00:00Z", summary: "x", station: "PEN", team: "A" },
      { id: "s2", type: "sec014", submitted_at: "2026-10-27T08:05:00Z", summary: "y", station: "JHB", team: "A" },
    ],
    incidents: [
      { id: "i1", incident_type: "SEAL", created_at: "2026-10-27T04:00:00Z", transaction_number: "CL-1", transaction_station: "PEN" },
      { id: "i2", incident_type: "SEAL", created_at: "2026-10-27T04:01:00Z", transaction_number: "CL-2", transaction_station: "JHB" },
    ],
  });
  const text = JSON.stringify(rows);
  assert.ok(text.includes("A One") && !text.includes("B Two"));
  assert.ok(text.includes("CL-1") && text.includes("CL-3") && !text.includes("CL-2"));
  assert.ok(rows.some((r) => r.key === "report-sec014-s1") && !rows.some((r) => r.key === "report-sec014-s2"));
  assert.ok(rows.some((r) => r.key === "incident-i1") && !rows.some((r) => r.key === "incident-i2"));
});

test("station activity: 'Route' is the movement route, 'Station/Location' is shown only when the record provides a station", () => {
  const rows = buildStationActivity(null, {
    duty: [],
    transactions: [tx({ station: "KUL", route: "HUB" }), tx({ transaction_number: "CL-NOSTN", station: null, route: "AIRCRAFT", hub_destination: null, origin_station_code: null, destination_station_code: null })],
    submissions: [{ id: "s1", type: "sec029", submitted_at: "2026-10-27T08:00:00Z", summary: "", station: null, team: null }],
    incidents: [],
  });
  const hub = rows.find((r) => r.key.startsWith("tx-CL-2026-000010"))!;
  assert.equal(hub.route, "HUB");
  assert.equal(hub.location, "KUL");
  const none = rows.find((r) => r.key.startsWith("tx-CL-NOSTN"))!;
  assert.equal(none.route, "AIRCRAFT", "AIRCRAFT is a route, never a station");
  assert.equal(none.location, null, "no station on the record -> no invented station");
  assert.equal(rows.find((r) => r.key.startsWith("report-"))!.route, null, "a report has no route");
  assert.deepEqual(transactionStations(tx({ station: null, hub_destination: "PEN", origin_station_code: null, destination_station_code: "KCH" })), ["PEN", "KCH"]);
});

test("station activity query: station-scoped in the query, validated station code, accurate 'loaded at' snapshot wording, Refresh link", () => {
  const q = read("lib/avsec/dashboard/activity-queries.ts");
  const st = q.slice(q.indexOf("export async function getStationActivity"));
  assert.match(st, /idByCode\.has\(station\)/, "only a known active station code is ever filtered on");
  assert.doesNotMatch(st, /supabase\.from\("org_stations"\)/, "signed-in users cannot read org_stations: the id/code lookup is a server-side reference read");
  assert.match(st, /dutyQuery\.eq\("station", safeStation\)/);
  assert.match(st, /txQuery\.or\(ors\.join\(","\)\)/);
  assert.match(st, /station: safeStation/);
  const page = read("app/page.tsx");
  assert.match(page, /Loaded at \{loadedAt\} MYT when this page opened\. It does not update by itself/);
  assert.doesNotMatch(page, /Live activity stream/, "a page-render snapshot must not be called live");
  assert.match(page, />Route<\/th>/);
  assert.match(page, />Station\/Location<\/th>/);
  assert.match(page, /My Recent Activity/);
});

test("both feeds keep readable mobile cards and a scrollable desktop table, on theme tokens only", () => {
  const page = read("app/page.tsx");
  assert.equal((page.match(/space-y-2 md:hidden/g) ?? []).length, 2);
  assert.equal((page.match(/hidden md:block/g) ?? []).length, 2);
  assert.equal((page.match(/role="region" aria-label="(My recent activity|Station activity) \(scrollable\)"/g) ?? []).length, 2);
});

test("acknowledgement and entity segregation code is untouched by this change", () => {
  // The report/entity rules live in these files; this task must not alter them (their dedicated suites cover the behaviour).
  const entity = read("lib/dashboard/entity-report-filters.ts");
  assert.match(entity, /report_sec029/);
  const ack = read("lib/avsec/acknowledgements/actions.ts");
  assert.match(ack, /export async function/);
});
