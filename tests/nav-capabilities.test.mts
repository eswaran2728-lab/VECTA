import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNavModel, navHrefs, NON_ROSTERED_LEADERSHIP_ROLES, ENTITY_LEADERSHIP_ROLES, DUTY_ROLE_CODES } from "../lib/dashboard/nav-capabilities.ts";

const ATTENDANCE_HREFS = ["/avsec/duty", "/avsec/duty/absences", "/avsec/duty/overtime", "/avsec/duty/timesheet"];

test("non-rostered leadership roles never see Duty / Check-In / Leave / Overtime / Timesheet", () => {
  for (const role of NON_ROSTERED_LEADERSHIP_ROLES) {
    const model = buildNavModel({ roleCodes: [role] });
    const hrefs = navHrefs(model);
    for (const h of ATTENDANCE_HREFS) assert.ok(!hrefs.includes(h), `${role} must not link ${h}`);
    assert.equal(model.duty, false, `${role} duty flag`);
    assert.equal(model.attendanceSelfService, false);
    assert.ok(!model.tabs.some((t) => ATTENDANCE_HREFS.includes(t.href)));
  }
});

test("there is no ASO fallback: unknown / unrecognised roles get the bare minimum, never station navigation", () => {
  const model = buildNavModel({ roleCodes: ["some_future_role"] });
  assert.equal(model.kind, "unknown");
  const hrefs = navHrefs(model);
  assert.deepEqual(hrefs.sort(), ["/avsec/my-dashboard", "/avsec/profile"].sort());
  assert.equal(model.duty, false);
});

test("no assignment -> no operational navigation at all", () => {
  const model = buildNavModel({ roleCodes: [] });
  assert.equal(model.kind, "none");
  assert.deepEqual(model.groups, []);
});

test("entity Boss: one overview entry, no duplicate Operation Dashboard, reports and directory are separate links", () => {
  for (const role of ["maa_boss", "aax_boss"]) {
    const hrefs = navHrefs(buildNavModel({ roleCodes: [role] }));
    assert.equal(hrefs.filter((h) => h === "/avsec/my-dashboard").length, 1);
    assert.ok(!hrefs.includes("/avsec/dashboard") && !hrefs.includes("/"));
    assert.ok(hrefs.includes("/avsec/entity-reports"));
    assert.ok(hrefs.includes("/avsec/directory"));
    assert.ok(hrefs.includes("/avsec/bay-board"));
    assert.ok(hrefs.includes("/avsec/management/announcements"));
    assert.ok(!hrefs.includes("/avsec/admin/entity-registrations"), "Boss has no registration administration");
    assert.ok(!hrefs.includes("/avsec/admin/users"));
  }
});

test("entity Admin: dedicated Registration Administration link", () => {
  for (const role of ["maa_admin", "aax_admin"]) {
    const hrefs = navHrefs(buildNavModel({ roleCodes: [role] }));
    assert.ok(hrefs.includes("/avsec/admin/entity-registrations"));
    assert.ok(hrefs.includes("/avsec/entity-reports") && hrefs.includes("/avsec/directory"));
  }
});

test("rostered roles keep Duty (including hub_se); operation_manager and main_enforcement have none of their own", () => {
  for (const role of ["aso", "so", "sso", "dse", "hub_se"]) {
    const model = buildNavModel({ roleCodes: [role] });
    assert.ok(navHrefs(model).includes("/avsec/duty"), `${role} keeps Duty`);
    assert.equal(model.duty, true);
  }
  assert.equal(buildNavModel({ roleCodes: ["aso"] }).attendanceSelfService, true);
  for (const role of ["operation_manager", "main_enforcement"]) {
    const hrefs = navHrefs(buildNavModel({ roleCodes: [role] }));
    assert.ok(!hrefs.includes("/avsec/duty"));
  }
  assert.ok(navHrefs(buildNavModel({ roleCodes: ["operation_manager"] })).includes("/avsec/admin/users"), "operation_manager keeps user administration");
});

test("CaterLink management stays in CaterLink", () => {
  const hrefs = navHrefs(buildNavModel({ roleCodes: ["caterlink_management"] }));
  assert.ok(hrefs.filter((h) => h !== "/avsec/profile").every((h) => h.startsWith("/icms/")));
});

test("multi-role profiles are never silently merged", () => {
  const model = buildNavModel({ roleCodes: ["aso", "maa_boss"] });
  assert.equal(model.kind, "multi_role");
  assert.equal(model.duty, false);
  assert.ok(!navHrefs(model).includes("/avsec/duty"));
  const selected = buildNavModel({ roleCodes: ["aso", "maa_boss"], selectedRoleCode: "maa_boss" });
  assert.equal(selected.kind, "entity_boss");
});

test("the duty role set matches the canonical dashboard definition and excludes every non-rostered leadership role", () => {
  for (const role of NON_ROSTERED_LEADERSHIP_ROLES) assert.ok(!DUTY_ROLE_CODES.has(role), role);
  for (const role of ENTITY_LEADERSHIP_ROLES) assert.ok(!DUTY_ROLE_CODES.has(role), role);
});

test("bottom tabs never exceed five and are drawn from the same model", () => {
  for (const role of ["aso", "dse", "maa_boss", "maa_admin", "ghod", "operation_manager", "profiling_aso"]) {
    const model = buildNavModel({ roleCodes: [role], canScan: true });
    assert.ok(model.tabs.length >= 1 && model.tabs.length <= 5, role);
  }
});
