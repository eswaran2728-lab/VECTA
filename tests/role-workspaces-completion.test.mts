import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLE_CAPABILITIES, canCreateReport, mayUseAttendanceSurface } from "../lib/auth/role-capabilities.ts";
import { buildNavModel, navHrefs } from "../lib/dashboard/nav-capabilities.ts";
import { LINK_HUB_CONFIG } from "../lib/dashboard/linkHubConfig.ts";
import { deriveCanonicalAccess } from "../lib/auth/canonical-access.ts";
import { isMainEnforcementOnly, isMainEnforcementPathForbidden, MAIN_ENFORCEMENT_ALLOWED_AVSEC_PREFIXES } from "../lib/supabase/middleware-gate-logic.ts";
// @ts-expect-error plain .mjs tooling module
import { planFixtureRefresh, resolveMode, selectFixtureAccount, AUTHORIZATION_PHRASE, FUTURE_LABEL } from "../scripts/staging/lib/future-fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const MIG = read("supabase/migrations/20261103000001_role_workspace_completion.sql");

const access = (...roleCodes: string[]) =>
  deriveCanonicalAccess(roleCodes.map((roleCode) => ({ roleCode, roleCategory: "x", aocCode: "MY", operatingEntityCode: null, departmentCode: null, unitCode: null, hubCode: null, stationCode: null, teamName: null, startsAt: "2026-01-01", endsAt: null })));

// ---------------------------------------------------------------- 1. Investigation is non-rostered, at every layer
test("Investigation (SSO / SO / ASO): non-rostered in the capability table, navigation, dashboard config, route guards and the database", () => {
  for (const role of ["investigation_sso", "investigation_so", "investigation_aso"]) {
    const cap = ROLE_CAPABILITIES[role];
    assert.equal(cap.rostered, false, role);
    assert.equal(cap.bayBoard, "none", role);
    assert.deepEqual(cap.reportForms, [], role);
    assert.equal(mayUseAttendanceSurface([role]), false, role);
    const hrefs = navHrefs(buildNavModel({ roleCodes: [role], canScan: true, canReceive: true }));
    for (const banned of ["/avsec/duty", "/avsec/duty/absences", "/avsec/duty/overtime", "/avsec/duty/timesheet", "/avsec/bay-board", "/avsec/admin/roster", "/avsec/scan"]) assert.ok(!hrefs.includes(banned), `${role} ${banned}`);
    for (const need of ["/avsec/my-dashboard", "/avsec/investigation/cases", "/avsec/reports/lookup", "/avsec/discussions", "/avsec/profile"]) assert.ok(hrefs.includes(need), `${role} ${need}`);
    const links = (LINK_HUB_CONFIG[role]?.links ?? []).map((l) => l.href);
    for (const banned of ["/avsec/duty", "/avsec/bay-board", "/avsec/admin/roster"]) assert.ok(!links.includes(banned), `${role} dashboard ${banned}`);
  }
  // server: every duty page and attendance action uses the attendance guard (denies a non-rostered caller)
  for (const p of ["absences", "overtime", "handover", "view/[id]", "zones"]) assert.match(read(`app/(avsec)/avsec/duty/${p}/page.tsx`), /requireAttendanceProfile\(\)/, p);
  assert.match(read("app/(avsec)/avsec/duty/page.tsx"), /requireRouteAccess\("\/avsec\/duty"/);
  // database: a trigger refuses the four attendance writes
  for (const t of ["duty_records", "absence_notices", "overtime_requests", "shift_handovers"]) assert.match(MIG, new RegExp(`on public\\.${t}\\b[^;]*enforce_rostered_actor`), t);
  assert.match(MIG, /'investigation_sso', 'investigation_so', 'investigation_aso'/);
});

// ---------------------------------------------------------------- 2. report forms follow the assigned function
test("report forms: one DB-backed resolver; pages, list and actions all use it; explicit seeds; no implicit grants", () => {
  assert.match(MIG, /create table if not exists public\.report_form_assignments/);
  assert.match(MIG, /function public\.can_create_report_form/);
  assert.match(MIG, /function public\.enforce_report_form_assignment/);
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) assert.ok(MIG.includes(`'${t}'`), t);
  for (const t of ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033"]) assert.match(read(`app/(avsec)/avsec/reports/${t}/page.tsx`), new RegExp(`requireReportFormAccess\\("${t}"\\)`), t);
  const actions = read("lib/avsec/reports/actions.ts");
  assert.match(actions, /mayCreateReportForm\(reportType\)/);
  assert.doesNotMatch(actions, /canCreateReport\(/);
  assert.match(read("app/(avsec)/avsec/home/page.tsx"), /getAllowedReportForms\(\)/);
  // seeds == documented defaults
  assert.match(MIG, /'aso', null, null, f,/);
  assert.match(MIG, /unnest\(array\['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'offload'\]\)/);
  assert.match(MIG, /\('profiling_aso', null, null, 'sec013'/);
  const staticDefaults = Object.fromEntries(Object.entries(ROLE_CAPABILITIES).filter(([, c]) => c.reportForms.length).map(([k, c]) => [k, [...c.reportForms].sort().join(",")]));
  assert.deepEqual(staticDefaults, { aso: "offload,sec014,sec016,sec018,sec029,sec033", profiling_aso: "sec013" });
  // required rules
  assert.equal(canCreateReport(["profiling_so"], "sec013"), false);
  for (const role of ["so", "sso", "dse", "hub_se", "sat_aso", "profiling_so"]) for (const f of ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "offload"] as const) assert.equal(canCreateReport([role], f), false, `${role} ${f}`);
});

// ---------------------------------------------------------------- 3. Operation Manager does not administer users
test("Operation Manager: no user administration (route, server actions, navigation); read-only staff search instead", () => {
  assert.match(read("lib/avsec/auth.ts"), /export const USER_ADMIN_ROLES: ProfileRole\[\] = \[\];/);
  const actions = read("lib/avsec/admin/actions.ts");
  assert.doesNotMatch(actions, /requireRole\((MANAGEMENT_ROLES|ADMIN_ROLES)\)/);
  assert.equal((actions.match(/requireRole\(USER_ADMIN_ROLES\)/g) ?? []).length, 7, "all seven account actions");
  assert.match(read("app/(avsec)/avsec/admin/users/page.tsx"), /requireRole\(USER_ADMIN_ROLES\)/);
  assert.ok(!navHrefs(buildNavModel({ roleCodes: ["operation_manager"] })).includes("/avsec/admin/users"));
  assert.ok(navHrefs(buildNavModel({ roleCodes: ["operation_manager"] })).includes("/avsec/operation/staff"));
  const staff = read("app/(avsec)/avsec/operation/staff/page.tsx");
  assert.match(staff, /search_operation_staff_secure/);
  assert.doesNotMatch(staff, /"use server"|<form[^>]*method="post"|action=\{/, "the staff page has no mutation");
  assert.match(MIG, /function public\.search_operation_staff_secure/);
  // the shared duty/zones/roster/leave/OT oversight stays with the Operation Manager
  assert.match(read("app/(avsec)/avsec/admin/zones/page.tsx"), /requireRole\(ADMIN_ROLES\)/);
});

// ---------------------------------------------------------------- 4. Main Enforcement: dedicated workspace only
test("Main Enforcement: the legacy management surface is closed at the edge (deny by default); the dedicated workspace is open", () => {
  const me = access("main_enforcement");
  assert.equal(isMainEnforcementOnly(me), true);
  for (const p of ["/avsec/dashboard", "/avsec/dashboard/heatmap", "/avsec/dashboard/duty-monitor", "/avsec/admin/users", "/avsec/admin/zones", "/avsec/admin/roster", "/avsec/admin/attendance-monitor",
    "/avsec/admin/attendance-report", "/avsec/admin/absences", "/avsec/admin/entity-registrations", "/avsec/admin/sheet-sync", "/avsec/duty", "/avsec/duty/overtime", "/avsec/duty/zones",
    "/avsec/reports/sec014", "/avsec/reports/sec016", "/avsec/reports/sec013", "/avsec/scan", "/avsec/flights", "/avsec/home", "/avsec/management/feedback", "/avsec/management/announcements",
    "/avsec/entity-reports", "/avsec/directory", "/avsec/history", "/avsec/feedback", "/api/avsec/export/attendance", "/api/avsec/export/overtime", "/api/avsec/export/excel", "/api/avsec/export/pdf/duty/123"]) {
    assert.equal(isMainEnforcementPathForbidden(p, me), true, `${p} must be closed`);
  }
  for (const p of ["/avsec/my-dashboard", "/avsec/enforcement/workforce", "/avsec/enforcement/search", "/avsec/investigation/cases", "/avsec/investigation/cases/abc", "/avsec/sat/reports", "/avsec/reports/lookup",
    "/avsec/reports/view/sec016/abc", "/avsec/discussions", "/avsec/discussions/moderation", "/avsec/bay-board", "/avsec/profile", "/api/avsec/export/pdf/sec016/abc", "/api/wois/chat"]) {
    assert.equal(isMainEnforcementPathForbidden(p, me), false, `${p} must stay open`);
  }
  // prefix tricks do not slip through
  assert.equal(isMainEnforcementPathForbidden("/avsec/enforcementx", me), true);
  assert.equal(isMainEnforcementPathForbidden("/avsec/reports/lookupx", me), true);
  // a mixed profile is decided by its other role's own gates
  assert.equal(isMainEnforcementPathForbidden("/avsec/duty", access("main_enforcement", "aso")), false);
  assert.equal(isMainEnforcementPathForbidden("/avsec/dashboard", access("operation_manager")), false);
  assert.ok(MAIN_ENFORCEMENT_ALLOWED_AVSEC_PREFIXES.every((p) => p.startsWith("/avsec/")));
  assert.match(read("lib/supabase/middleware.ts"), /isMainEnforcementPathForbidden\(path, access\)/);
  assert.match(read("lib/supabase/middleware.ts"), /status: 403[\s\S]{0,200}|isMainEnforcementPathForbidden\(path, deriveCanonicalAccess/);
  // landing + nav
  const hrefs = navHrefs(buildNavModel({ roleCodes: ["main_enforcement"] }));
  for (const h of hrefs) assert.equal(isMainEnforcementPathForbidden(h, me), false, `nav link ${h} must not be closed at the edge`);
});

test("Main Enforcement: no server action or RPC of the legacy surface admits it", () => {
  for (const f of ["lib/avsec/admin/actions.ts", "lib/avsec/duty/zone-actions.ts", "lib/avsec/duty/roster-actions.ts", "lib/avsec/duty/attendance-actions.ts", "lib/avsec/admin/sheetSyncActions.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /requireRole\([^)]*ENFORCEMENT/, f);
    assert.doesNotMatch(src, /ORG_WIDE_ROLES\]\)/, f);
  }
  assert.match(read("lib/phase8/auth.ts"), /has_active_role/);
});

// ---------------------------------------------------------------- 5. Investigation case links / evidence / timeline
test("Investigation cases: flight, staff and evidence links, timeline, closure and audit use scoped RPCs and a private bucket", () => {
  for (const fn of ["link_flight_to_case_secure", "link_staff_to_case_secure", "list_investigation_case_links_secure", "prepare_case_evidence_secure", "register_case_evidence_secure",
    "list_investigation_case_evidence_secure", "authorize_case_evidence_download_secure", "close_investigation_case_secure", "get_investigation_case_timeline_secure", "list_investigation_case_audit_secure"]) {
    assert.match(MIG, new RegExp(`function public\\.${fn}`), fn);
    assert.match(MIG, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`), `${fn} revoke`);
  }
  assert.match(MIG, /insert into storage\.buckets \(id, name, public\) values \('investigation-evidence', 'investigation-evidence', false\)/);
  assert.match(MIG, /create policy "investigation evidence object select"/);
  assert.doesNotMatch(MIG, /create policy "investigation evidence[^"]*" on storage\.objects for insert/, "no client INSERT policy on the evidence bucket");
  assert.match(MIG, /Case evidence is append-only/);
  assert.match(MIG, /This case is closed\. Reopen it before/);
  const extras = read("lib/phase8/investigation-extras.ts");
  assert.match(extras, /prepare_case_evidence_secure[\s\S]*upload[\s\S]*register_case_evidence_secure/, "authorize -> upload -> register");
  assert.match(extras, /authorize_case_evidence_download_secure[\s\S]*createSignedUrl/, "authorize (audited) before signing");
  assert.doesNotMatch(extras, /getPublicUrl|public_url/);
  const page = read("app/(avsec)/avsec/investigation/cases/[id]/page.tsx");
  for (const s of ["Flights and staff", "Evidence", "Timeline", "Audit history"]) assert.match(page, new RegExp(`aria-label="${s}"`), s);
  assert.match(page, /CloseCaseForm/);
});

// ---------------------------------------------------------------- 6. the four user-facing workflows
test("Compliance CaterLink view is read-only: no scanner, completion, incident, QR or administration action", () => {
  const page = read("app/(avsec)/avsec/caterlink/movements/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(page, /list_caterlink_movements_readonly_secure/);
  assert.doesNotMatch(page, /<form[^>]*method="post"|<button|action=\{|"use server"|confirm_caterlink|resolve_caterlink|scan|signature/i);
  assert.match(MIG, /Only Compliance or the Operation Manager may view the read-only CaterLink movements/);
  const mov = MIG.slice(MIG.indexOf("function public.list_caterlink_movements_readonly_secure"), MIG.indexOf("-- 6b. Hub SE"));
  assert.doesNotMatch(mov.slice(mov.indexOf("select m.id, m.transaction_number")), /driver_id|driver_name|qr_token|seal_number/, "no driver identity, QR token or seal in the read-only list");
  assert.ok(navHrefs(buildNavModel({ roleCodes: ["compliance"] })).includes("/avsec/caterlink/movements"));
  assert.ok(!navHrefs(buildNavModel({ roleCodes: ["compliance"] })).some((h) => h.startsWith("/icms") || h === "/avsec/scan"));
});

test("Hub SE selector: only stations of the assigned hub, capability-gated actions", () => {
  const page = read("app/(avsec)/avsec/hub/page.tsx");
  assert.match(page, /list_hub_stations_secure/);
  assert.match(page, /get_hub_station_overview_secure/);
  assert.match(page, /aria-label="Station selector"/);
  assert.match(MIG, /That station is not in your assigned hub/);
  assert.match(MIG, /caller_hub_se_hub/);
  assert.ok(navHrefs(buildNavModel({ roleCodes: ["hub_se"] })).includes("/avsec/hub"));
});

test("GHOD / AirAsia request interface: metadata stubs only; GRC decides; grants are read-only, time-bounded, audited", () => {
  assert.match(MIG, /function public\.search_report_stubs_for_request_secure/);
  assert.match(MIG, /Only GHOD or AirAsia Management with an active assignment may request report access/);
  const stubs = MIG.slice(MIG.indexOf("function public.search_report_stubs_for_request_secure"), MIG.indexOf("function public.list_my_report_access_requests_secure"));
  assert.doesNotMatch(stubs, /staff_name|reg_no|station\b|content/, "stubs carry no staff, registration, station or content");
  for (const role of ["ghod", "airasia_management"]) {
    assert.ok(navHrefs(buildNavModel({ roleCodes: [role] })).includes("/avsec/reports/request-access"), role);
    assert.ok(!navHrefs(buildNavModel({ roleCodes: [role] })).includes("/avsec/reports/lookup"), `${role} stays out of routine report browsing`);
  }
  assert.match(read("app/(avsec)/avsec/reports/request-access/page.tsx"), /!roles\.includes\("ghod"\) && !roles\.includes\("airasia_management"\)\) redirect/);
});

test("BKI / KCH final receipt: receipt only, capability-gated, verification + discrepancy + signature recorded", () => {
  const page = read("app/(avsec)/avsec/caterlink/receipt/page.tsx");
  assert.match(page, /can_user_confirm_caterlink_receipt/);
  assert.doesNotMatch(page, /\/avsec\/scan|\/icms\//, "no scanner or CaterLink stream from the receipt screen");
  const action = read("lib/avsec/caterlink/receipt.ts");
  assert.match(action, /confirm_caterlink_destination_receipt_secure/);
  assert.match(action, /DISCREPANCY/);
  assert.match(action, /Describe the discrepancy/);
  assert.match(read("components/avsec/caterlink/ReceiptForm.tsx"), /SignatureField/);
  // receipt-only stations get the receipt link and NOT the scanner / stream; scanner stations keep theirs
  const receiptOnly = navHrefs(buildNavModel({ roleCodes: ["aso"], canScan: false, canReceive: true }));
  assert.ok(receiptOnly.includes("/avsec/caterlink/receipt") && !receiptOnly.includes("/avsec/scan") && !receiptOnly.includes("/icms/transactions"));
  const scanner = navHrefs(buildNavModel({ roleCodes: ["aso"], canScan: true, canReceive: true }));
  assert.ok(scanner.includes("/avsec/scan") && scanner.includes("/icms/transactions") && !scanner.includes("/avsec/caterlink/receipt"));
  const none = navHrefs(buildNavModel({ roleCodes: ["aso"], canScan: false, canReceive: false }));
  assert.ok(!none.some((h) => h.startsWith("/icms") || h === "/avsec/scan" || h.includes("caterlink")), "BTU: no CaterLink at all");
  assert.match(MIG, /function public\.list_caterlink_pending_receipts_secure/);
});

// ---------------------------------------------------------------- 7. future-assignment fixture refresh
test("fixture refresh: staging-only, dry-run by default, exact account, idempotent, no secrets", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  assert.equal(resolveMode({ apply: false }), "dry-run");
  assert.throws(() => resolveMode({ apply: true, authorization: "yes", envConfirmation: "yes" }));
  assert.throws(() => resolveMode({ apply: true, authorization: AUTHORIZATION_PHRASE, envConfirmation: undefined }));
  assert.equal(resolveMode({ apply: true, authorization: AUTHORIZATION_PHRASE, envConfirmation: "yes" }), "live");
  assert.throws(() => selectFixtureAccount([{ label: "aso-kul", accountState: "active" }]));
  assert.throws(() => selectFixtureAccount([{ label: FUTURE_LABEL }, { label: "x", accountState: "future_dated" }]));
  assert.equal(selectFixtureAccount([{ label: "aso-kul" }, { label: FUTURE_LABEL, email: "x" }]).label, FUTURE_LABEL);
  // the drifted fixture (start passed) is refreshed ~10 years ahead; an already-far start is a no-op (idempotent)
  const drifted = planFixtureRefresh([{ id: "a", starts_at: "2026-10-06T00:00:00Z", ends_at: null, revoked_at: null }], now);
  assert.equal(drifted.action, "update");
  assert.ok(new Date(drifted.newStartsAt).getTime() - +now > 3000 * 86_400_000);
  assert.equal(planFixtureRefresh([{ id: "a", starts_at: drifted.newStartsAt, ends_at: null, revoked_at: null }], now).action, "noop");
  assert.throws(() => planFixtureRefresh([], now));
  assert.throws(() => planFixtureRefresh([{ id: "a", starts_at: "2026-01-01", ends_at: null }, { id: "b", starts_at: "2026-01-01", ends_at: null }], now));
  assert.throws(() => planFixtureRefresh([{ id: "a", starts_at: "2026-01-01", ends_at: "2027-01-01" }], now));
  const script = read("scripts/staging/refresh-future-assignment-fixture.mjs");
  assert.match(script, /environmentGates\(\)/);
  assert.match(script, /FORBIDDEN_REF/);
  assert.match(script, /rollback/);
  assert.match(script, /connectVerified/);
  assert.doesNotMatch(script, /console\.log\([^)]*(password|secret|process\.env|email)/i);
  assert.match(script, /update public\.user_role_assignments set starts_at = \$2 where id = \$1 and profile_id = \$3/);
  assert.doesNotMatch(script, /delete from|drop |truncate|auth\.users set|update public\.profiles/i);
});

// ---------------------------------------------------------------- 8. component-level responsive / accessibility preparation
const NEW_PAGES = [
  "app/(avsec)/avsec/caterlink/receipt/page.tsx",
  "app/(avsec)/avsec/caterlink/movements/page.tsx",
  "app/(avsec)/avsec/hub/page.tsx",
  "app/(avsec)/avsec/reports/request-access/page.tsx",
  "app/(avsec)/avsec/operation/staff/page.tsx",
  "app/(avsec)/avsec/reports/requests/page.tsx",
  "app/(avsec)/avsec/entity-reports/page.tsx",
  "app/(avsec)/avsec/directory/page.tsx",
  "app/(avsec)/avsec/admin/entity-staff/page.tsx",
  "app/(avsec)/avsec/admin/entity-registrations/page.tsx",
];
test("new pages: denied, empty and error states are present and announced; tables scroll inside their card; no fixed-width page", () => {
  for (const f of NEW_PAGES) {
    const src = read(f);
    assert.match(src, /role="status"|role="alert"/, `${f}: empty/error states are announced`);
    assert.match(src, /redirect\(|requireEntityLeadership|requireRouteAccess|requireProfile/, `${f}: denied state (redirect) or guard`);
    if (/<table/.test(src)) {
      assert.match(src, /overflow-x-auto/, `${f}: table scrolls inside its card`);
      assert.match(src, /<thead/, `${f}: table has a header row`);
    }
    assert.doesNotMatch(src, /\bw-\[\d{4,}px\]|min-w-\[(?:[6-9]\d|\d{3,})rem\]/, `${f}: no oversized fixed width`);
    assert.match(src, /<main className="min-h-screen/, `${f}: page landmark`);
  }
});

test("new forms and controls: >=44px touch targets, labelled fields, status messages, visible focus rings (global form styles)", () => {
  const files = [
    "components/avsec/caterlink/ReceiptForm.tsx", "components/avsec/reports/RequestAccessButton.tsx", "components/avsec/reports/GrcRowActions.tsx",
    "components/avsec/investigation/CaseExtras.tsx", "components/avsec/admin/EntityStaffManager.tsx", "components/avsec/admin/EntityRegistrationsView.tsx",
    "components/dashboard/DirectoryExportButton.tsx",
  ];
  for (const f of files) {
    const src = read(f);
    assert.match(src, /min-h-\[44px\]/, `${f}: touch target`);
    assert.match(src, /aria-label|<label|<button/, `${f}: accessible names`);
    assert.match(src, /role="status"|role="alert"/, `${f}: announced results`);
  }
  const css = read("app/globals.css");
  assert.match(css, /focus-visible|:focus/, "a visible focus style exists globally");
  const drawer = read("components/layout/NavDrawer.tsx");
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /Escape/);
  assert.match(read("components/layout/NavGroupsList.tsx"), /focus-visible:ring-2/);
  assert.match(read("components/layout/TeamBottomNav.tsx"), /lg:hidden/);
});
