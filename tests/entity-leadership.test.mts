import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveCanonicalAccess } from "../lib/auth/canonical-access.ts";
import { isAdminPathForbiddenFor, isShiftBasedAccess } from "../lib/supabase/middleware-gate-logic.ts";
import { entityLeadershipFromRoleCodes } from "../lib/dashboard/entity-leadership-roles.ts";
import { parseEntityReportFilters, reportViewHref, REPORT_TYPE_OPTIONS } from "../lib/dashboard/entity-report-filters.ts";
import { firstMissingScopeField, requiredScopeFields, PROTECTED_ROLE_CODES } from "../lib/avsec/admin/registration-scope.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function accessFor(roleCode: string) {
  return deriveCanonicalAccess([
    { roleCode, roleCategory: "x", aocCode: "MY", operatingEntityCode: null, departmentCode: null, unitCode: null, hubCode: null, stationCode: null, teamName: null, startsAt: "2026-01-01", endsAt: null },
  ]);
}

test("edge gate: entity registration route is open to MAA/AAX Admin only; the rest of /avsec/admin stays closed to them", () => {
  for (const role of ["maa_admin", "aax_admin"]) {
    const access = accessFor(role);
    assert.equal(isAdminPathForbiddenFor("/avsec/admin/entity-registrations", null, access), false, role);
    assert.equal(isAdminPathForbiddenFor("/avsec/admin/users", null, access), true, `${role} still has no user administration`);
  }
  for (const role of ["maa_boss", "aax_boss", "aso", "ghod"]) {
    assert.equal(isAdminPathForbiddenFor("/avsec/admin/entity-registrations", null, accessFor(role)), true, role);
  }
});

test("check-in gate: leadership is never shift-based; rostered roles still are", () => {
  for (const role of ["maa_boss", "maa_admin", "aax_boss", "aax_admin", "ghod", "airasia_management", "global_reporting_controller"]) {
    assert.equal(isShiftBasedAccess(accessFor(role)), false, role);
  }
  for (const role of ["aso", "so", "sso", "dse"]) assert.equal(isShiftBasedAccess(accessFor(role)), true, role);
});

test("entityLeadershipFromRoleCodes: derives entity and boss/admin flags from canonical codes only", () => {
  assert.deepEqual(entityLeadershipFromRoleCodes(["maa_boss"]), { entityCode: "MAA", isBoss: true, isAdmin: false });
  assert.deepEqual(entityLeadershipFromRoleCodes(["aax_admin"]), { entityCode: "AAX", isBoss: false, isAdmin: true });
  assert.equal(entityLeadershipFromRoleCodes(["aso", "ghod"]), null);
  assert.equal(entityLeadershipFromRoleCodes([]), null);
});

test("report filters: invalid input is dropped, ranges are ordered, page is bounded", () => {
  const f = parseEntityReportFilters({ page: "-3", from: "2026-02-30", to: "2026-03-01", type: "profiles", status: "nope", flight: "  AK703  ", reg: "9M-AXA" });
  assert.equal(f.page, 1);
  assert.equal(f.from, null, "impossible date dropped");
  assert.equal(f.to, "2026-03-01");
  assert.equal(f.sourceTable, null, "non-report table dropped");
  assert.equal(f.status, null);
  assert.equal(f.flight, "AK703");
  assert.equal(f.registration, "9M-AXA");
  const swapped = parseEntityReportFilters({ from: "2026-05-02", to: "2026-05-01" });
  assert.deepEqual([swapped.from, swapped.to], ["2026-05-01", "2026-05-02"]);
  for (const o of REPORT_TYPE_OPTIONS) assert.equal(parseEntityReportFilters({ type: o.value }).sourceTable, o.value);
});

test("report view href: keyed by source table + SOURCE id; offload has no viewer", () => {
  assert.equal(reportViewHref("report_sec016", "abc"), "/avsec/reports/view/sec016/abc");
  assert.equal(reportViewHref("offload_records", "abc"), null);
  assert.equal(reportViewHref("profiles", "abc"), null);
});

test("registration scope: required selectors follow the role and mirror the database rules", () => {
  assert.deepEqual(requiredScopeFields("aso"), ["department", "hub", "station", "team"]);
  assert.deepEqual(requiredScopeFields("hub_se"), ["department", "hub"]);
  assert.deepEqual(requiredScopeFields("investigation_so"), ["department", "unit"]);
  assert.deepEqual(requiredScopeFields("profiling_aso"), ["department", "unit", "hub", "station", "team"]);
  assert.equal(requiredScopeFields("maa_boss"), null, "protected roles have no self-service form");
  assert.equal(firstMissingScopeField("aso", { departmentId: "d", hubId: "h", stationId: "s" }), "team");
  assert.equal(firstMissingScopeField("aso", { departmentId: "d", hubId: "h", stationId: "s", teamId: "t" }), null);
  for (const role of ["maa_boss", "aax_boss", "maa_admin", "aax_admin", "ghod", "super_admin", "operation_manager"]) assert.ok(PROTECTED_ROLE_CODES.includes(role), role);
});

test("closure: no application page or library reads central_reports_index directly", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name) && rel !== "lib/supabase/database.types.ts" && /\.from\(["']central_reports_index["']\)/.test(read(rel))) offenders.push(rel);
    }
  };
  for (const d of ["app", "lib", "components"]) walk(d);
  assert.deepEqual(offenders, []);
});

test("closure: the registration form takes no AOC or entity from the browser", () => {
  const view = read("components/avsec/admin/EntityRegistrationsView.tsx");
  const actions = read("lib/avsec/admin/entity-registrations.ts");
  assert.doesNotMatch(view, /name="aocId"|AOC uuid|placeholder="AOC/i);
  assert.doesNotMatch(actions, /formData\.get\("aocId"\)|formData\.get\("operatingEntityCode"\)/);
  assert.match(actions, /list_registration_assignment_options_secure/);
});

test("closure: reports and directory are separate pages and the dashboard links both", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "app/(avsec)/avsec/entity-reports/page.tsx")));
  assert.ok(fs.existsSync(path.join(ROOT, "app/(avsec)/avsec/directory/page.tsx")));
  const boss = read("components/dashboard/EntityDashboard.tsx");
  assert.match(boss, /href="\/avsec\/entity-reports"/);
  assert.match(boss, /href="\/avsec\/directory"/);
  const admin = read("components/dashboard/EntityAdminDashboard.tsx");
  assert.match(admin, /href="\/avsec\/admin\/entity-registrations"/);
  assert.doesNotMatch(admin, /href="\/avsec\/admin\/users"|href="\/avsec\/admin\/roster"/, "no dead admin dashboard links");
});
