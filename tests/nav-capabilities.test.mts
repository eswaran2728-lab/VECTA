import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNavModel, navHrefs, NON_ROSTERED_LEADERSHIP_ROLES } from "../lib/dashboard/nav-capabilities.ts";
import { ROLE_CAPABILITIES, roleLabelFor, primaryRoleLabel, mayUseAttendanceSurface, canCreateReport } from "../lib/auth/role-capabilities.ts";
import { COMPAT_ROLE_BY_CANONICAL } from "../lib/auth/compat-role-map.mjs";

const SELF_ATTENDANCE = ["/avsec/duty", "/avsec/duty/timesheet"]; // personal duty / timesheet
const nav = (role: string, canScan = false) => navHrefs(buildNavModel({ roleCodes: [role], canScan }));

const ALL_ROLES = [
  "airasia_management", "ghod", "global_reporting_controller", "super_admin", "maa_boss", "maa_admin", "aax_boss", "aax_admin",
  "operation_manager", "main_enforcement", "compliance", "caterlink_management", "investigation_sso", "investigation_so", "investigation_aso",
  "sat_aso", "profiling_so", "profiling_aso", "hub_se", "dse", "sso", "so", "aso",
];

test("the capability table covers EXACTLY the canonical roles of the compatibility map (no role is missing, none is invented)", () => {
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES).sort(), Object.keys(COMPAT_ROLE_BY_CANONICAL).sort());
  assert.deepEqual([...ALL_ROLES].sort(), Object.keys(ROLE_CAPABILITIES).sort());
});

test("every role has a model: a dashboard entry, a profile entry, no duplicate destinations, and an exact label", () => {
  for (const role of ALL_ROLES) {
    if (role === "super_admin") continue; // technical-only portal: no AVSEC chrome at all
    const model = buildNavModel({ roleCodes: [role], canScan: true });
    const hrefs = navHrefs(model);
    assert.ok(hrefs.includes("/avsec/profile") || role === "caterlink_management" || hrefs.length > 0, role);
    assert.equal(model.roleLabel, roleLabelFor(role), role);
    assert.ok(model.tabs.length >= 1 && model.tabs.length <= 5, `${role} tabs`);
    // "My Dashboard" / "Operations Dashboard" style duplicates: a destination appears once
    const plain = model.groups.flatMap((g) => g.items).filter((i) => !i.href.includes("?") && !i.href.includes("#")).map((i) => i.href);
    assert.equal(new Set(plain).size, plain.length, `${role} has a duplicated destination`);
  }
});

test("non-rostered roles never see Duty / Check-In / personal Leave / personal OT / Timesheet", () => {
  const forbidden = ["/avsec/duty", "/avsec/duty/timesheet", "/avsec/duty/absences", "/avsec/duty/overtime"];
  for (const role of ["airasia_management", "ghod", "global_reporting_controller", "maa_boss", "maa_admin", "aax_boss", "aax_admin", "compliance", "investigation_sso", "investigation_so", "investigation_aso"]) {
    for (const h of forbidden) assert.ok(!nav(role).includes(h), `${role} must not link ${h}`);
    const model = buildNavModel({ roleCodes: [role] });
    assert.equal(model.duty, false, role);
    assert.equal(model.attendanceSelfService, false, role);
    assert.equal(mayUseAttendanceSurface([role]), false, role);
  }
  // listed explicitly
  for (const r of ["compliance", "investigation_aso", "ghod", "maa_admin"]) assert.ok(NON_ROSTERED_LEADERSHIP_ROLES.includes(r), r);
});

test("oversight roles use the shared approval queues but have no personal duty / timesheet", () => {
  for (const role of ["operation_manager", "main_enforcement"]) {
    for (const h of SELF_ATTENDANCE) assert.ok(!nav(role).includes(h), `${role} ${h}`);
    assert.equal(mayUseAttendanceSurface([role]), true, role);
  }
  assert.ok(nav("operation_manager").includes("/avsec/duty/overtime"), "final OT approval");
  assert.ok(nav("operation_manager").includes("/avsec/admin/absences"), "leave escalation");
  assert.ok(nav("operation_manager").includes("/avsec/admin/attendance-monitor"));
  assert.ok(nav("operation_manager").includes("/avsec/admin/zones"), "keeps duty/geofence zones");
});

test("rostered roles keep Duty (including Hub SE) and personal attendance where they apply", () => {
  for (const role of ["aso", "so", "sso", "dse", "hub_se", "sat_aso", "profiling_so", "profiling_aso"]) {
    assert.ok(nav(role).includes("/avsec/duty"), `${role} keeps Duty`);
    assert.equal(buildNavModel({ roleCodes: [role] }).duty, true, role);
    assert.ok(nav(role).includes("/avsec/bay-board"), `${role} Bay Board`);
  }
  for (const role of ["aso", "so", "sso", "sat_aso", "profiling_so", "profiling_aso"]) {
    assert.ok(nav(role).includes("/avsec/duty/timesheet"), `${role} timesheet`);
    assert.ok(nav(role).includes("/avsec/duty/absences") && nav(role).includes("/avsec/duty/overtime"), `${role} leave and OT`);
  }
});

test("Operation Manager is narrowed: no generic user administration, no report filing, no legacy feedback inbox", () => {
  const h = nav("operation_manager");
  assert.ok(!h.includes("/avsec/admin/users"));
  assert.ok(!h.includes("/?section=reports") && !h.some((x) => x.includes("section=reports")));
  assert.ok(!h.includes("/avsec/management/feedback"));
  assert.ok(!h.includes("/avsec/management/announcements"), "Operation Manager cannot publish announcements");
});

test("Main Enforcement gets a dedicated enforcement workspace (no legacy management menu)", () => {
  const h = nav("main_enforcement");
  for (const need of ["/avsec/my-dashboard", "/avsec/enforcement/workforce", "/avsec/investigation/cases", "/avsec/sat/reports", "/avsec/enforcement/search", "/avsec/reports/lookup"]) {
    assert.ok(h.includes(need), need);
  }
  for (const gone of ["/avsec/admin/users", "/avsec/admin/zones", "/icms/transactions", "/avsec/management/feedback", "/avsec/dashboard"]) assert.ok(!h.includes(gone), gone);
  assert.ok(!h.some((x) => x.includes("section=reports")), "no frontline report filing");
});

test("Investigation: Malaysia-wide search + case workspace, no station operations", () => {
  for (const role of ["investigation_sso", "investigation_so", "investigation_aso"]) {
    const h = nav(role);
    assert.ok(h.includes("/avsec/investigation/cases") && h.includes("/avsec/reports/lookup") && h.includes("/avsec/enforcement/search"), role);
    assert.ok(!h.includes("/avsec/bay-board") && !h.includes("/avsec/duty"), role);
  }
});

test("Compliance is read-only: search + flight dashboard + discussions, nothing operational", () => {
  const h = nav("compliance", true);
  assert.deepEqual([...new Set(h)].sort(), ["/avsec/caterlink/movements", "/avsec/discussions", "/avsec/flights", "/avsec/my-dashboard", "/avsec/profile", "/avsec/reports/lookup"].sort());
  assert.equal(canCreateReport(["compliance"], "sec016"), false);
});

test("SAT / Profiling differences", () => {
  assert.ok(nav("sat_aso").includes("/avsec/sat/reports"));
  assert.ok(nav("profiling_aso").includes("/avsec/reports/sec013"));
  assert.ok(!nav("profiling_so").includes("/avsec/reports/sec013"), "Profiling SO has no report-creation action");
  assert.ok(nav("profiling_so").includes("/avsec/profiling/workspace"), "Profiling SO acknowledgement queue");
  for (const role of ["profiling_so", "profiling_aso"]) assert.ok(!nav(role, true).some((x) => x.startsWith("/icms") || x === "/avsec/scan"), `${role}: no CaterLink`);
  assert.deepEqual(ROLE_CAPABILITIES.profiling_aso.reportForms, ["sec013"]);
  assert.deepEqual(ROLE_CAPABILITIES.profiling_so.reportForms, []);
});

test("report-form creation is a per-role rule, not 'every ASO gets all forms'", () => {
  assert.equal(canCreateReport(["aso"], "sec016"), true);
  assert.equal(canCreateReport(["aso"], "sec013"), false, "SEC013 belongs to the Profiling unit");
  for (const role of ["so", "sso", "dse", "hub_se", "sat_aso", "profiling_so", "operation_manager", "main_enforcement", "maa_boss", "ghod"]) {
    assert.equal(canCreateReport([role], "sec016"), false, `${role} cannot file SEC016`);
  }
  assert.equal(canCreateReport(["profiling_aso"], "sec016"), false);
});

test("labels are exact: SSO is SSO (not SO), Hub SE is Hub SE (not DSE)", () => {
  assert.equal(roleLabelFor("sso"), "SSO");
  assert.equal(roleLabelFor("so"), "SO");
  assert.equal(roleLabelFor("hub_se"), "Hub SE");
  assert.equal(roleLabelFor("dse"), "DSE");
  assert.equal(primaryRoleLabel(["sso"]), "SSO");
  assert.equal(primaryRoleLabel(["hub_se"]), "Hub SE");
  assert.equal(roleLabelFor("maa_admin"), "MAA Admin");
  for (const role of ALL_ROLES) assert.doesNotMatch(roleLabelFor(role) ?? "", /MANAGEMENT$/, role);
  assert.equal(roleLabelFor("not_a_role"), null);
});

test("Hub SE has a hub workspace, roster and approval queues (not the generic DSE menu)", () => {
  const h = nav("hub_se");
  for (const need of ["/avsec/my-dashboard", "/avsec/admin/roster", "/avsec/duty/absences", "/avsec/duty/overtime", "/avsec/bay-board", "/avsec/duty"]) assert.ok(h.includes(need), need);
  assert.equal(buildNavModel({ roleCodes: ["hub_se"] }).kind, "hub");
});

test("Global roles: AirAsia Management and GHOD are executive-only; GRC has the request queue", () => {
  for (const role of ["airasia_management", "ghod"]) {
    const h = nav(role);
    assert.ok(!h.includes("/avsec/bay-board") && !h.includes("/avsec/reports/lookup"), role);
  }
  assert.ok(nav("ghod").includes("/avsec/management/announcements"), "GHOD: Global announcements");
  const grc = nav("global_reporting_controller");
  for (const need of ["/avsec/reports/lookup", "/avsec/reports/requests"]) assert.ok(grc.includes(need), need);
  assert.ok(!grc.includes("/avsec/bay-board"));
});

test("Boss / Admin: one overview, separate reports and directory, admin-only registrations, read-only Bay Board", () => {
  for (const role of ["maa_boss", "aax_boss"]) {
    const h = nav(role);
    assert.ok(h.includes("/avsec/entity-reports") && h.includes("/avsec/directory") && h.includes("/avsec/bay-board"));
    assert.ok(!h.includes("/avsec/admin/entity-registrations") && !h.includes("/avsec/dashboard"));
  }
  for (const role of ["maa_admin", "aax_admin"]) assert.ok(nav(role).includes("/avsec/admin/entity-registrations"));
});

test("CaterLink Management stays in CaterLink", () => {
  assert.ok(nav("caterlink_management").filter((h) => h !== "/avsec/profile").every((h) => h.startsWith("/icms/")));
});

test("no ASO fallback: unknown roles get the minimum; no assignment gets nothing; several roles are never merged", () => {
  assert.deepEqual(nav("some_future_role").sort(), ["/avsec/my-dashboard", "/avsec/profile"]);
  assert.equal(buildNavModel({ roleCodes: [] }).kind, "none");
  const multi = buildNavModel({ roleCodes: ["aso", "maa_boss"] });
  assert.equal(multi.kind, "multi_role");
  assert.ok(!navHrefs(multi).includes("/avsec/duty"));
  assert.equal(buildNavModel({ roleCodes: ["aso", "maa_boss"], selectedRoleCode: "maa_boss" }).kind, "entity_boss");
});
