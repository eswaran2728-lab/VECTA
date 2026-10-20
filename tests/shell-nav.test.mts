import test from "node:test";
import assert from "node:assert/strict";
import { buildNavModel, navHrefs, NON_ROSTERED_LEADERSHIP_ROLES } from "../lib/dashboard/nav-capabilities.ts";
import { ROLE_CAPABILITIES } from "../lib/auth/role-capabilities.ts";
import { deriveShellNav, SHELL_SLOTS } from "../lib/dashboard/shell-nav.ts";

const ALL_ROLES = Object.keys(ROLE_CAPABILITIES);
const model = (role: string, extra: { canScan?: boolean; canReceive?: boolean } = {}) => buildNavModel({ roleCodes: [role], ...extra });
const shellHrefs = (role: string, extra: { canScan?: boolean; canReceive?: boolean } = {}) => {
  const s = deriveShellNav(model(role, extra));
  return [s.home?.href, s.reports?.href, ...s.actions.flatMap((g) => g.items.map((i) => i.href)), ...s.menu.flatMap((g) => g.items.map((i) => i.href))].filter(Boolean) as string[];
};

test("the mobile bottom navigation has exactly the approved slots, in order", () => {
  assert.deepEqual([...SHELL_SLOTS], ["home", "reports", "actions", "alerts", "more"]);
});

test("the shell never invents a destination: every link comes from the role's own navigation model", () => {
  for (const role of ALL_ROLES) {
    for (const extra of [{}, { canScan: true }, { canReceive: true }, { canScan: true, canReceive: true }]) {
      const m = model(role, extra);
      const allowed = new Set(navHrefs(m).map((h) => h.split("#")[0].split("?")[0]));
      const s = deriveShellNav(m);
      for (const href of shellHrefs(role, extra)) {
        const path = href.split("#")[0].split("?")[0];
        assert.ok(allowed.has(path) || (path === "/" && m.kind === "station_operator"), `${role}: ${href} is not in the role's model`);
      }
      assert.deepEqual(s.menu, m.groups, `${role}: the full menu equals the model, nothing becomes unreachable on mobile`);
    }
  }
});

test("non-rostered Boss/Admin and executive roles never receive Duty check-in or check-out", () => {
  for (const role of [...NON_ROSTERED_LEADERSHIP_ROLES, "airasia_management", "ghod", "global_reporting_controller", "operation_manager", "main_enforcement", "compliance", "caterlink_management"]) {
    if (!ROLE_CAPABILITIES[role]) continue;
    assert.ok(!shellHrefs(role).includes("/avsec/duty"), `${role} must not see Duty check-in`);
  }
});

test("rostered station roles do keep Duty, and the scanner only where the station holds the capability", () => {
  assert.ok(shellHrefs("aso").includes("/avsec/duty"));
  assert.ok(!shellHrefs("aso", { canScan: false }).includes("/avsec/scan"));
  assert.ok(shellHrefs("aso", { canScan: true }).includes("/avsec/scan"));
  assert.ok(!shellHrefs("aso", { canReceive: false }).includes("/avsec/caterlink/receipt"));
  assert.ok(shellHrefs("aso", { canReceive: true }).includes("/avsec/caterlink/receipt"));
});

test("a station ASO gets Home and a Reports entry that points at the existing report section of the home page", () => {
  const s = deriveShellNav(model("aso"));
  assert.equal(s.home?.href, "/");
  assert.equal(s.reports?.href, "/#reports");
  assert.ok(s.reports?.match?.includes("/avsec/history"));
});

test("report-capable roles point Reports at their real report route", () => {
  assert.equal(deriveShellNav(model("global_reporting_controller")).reports?.href, "/avsec/reports/lookup");
  assert.equal(deriveShellNav(model("maa_boss")).reports?.href, "/avsec/entity-reports");
  assert.equal(deriveShellNav(model("maa_admin")).reports?.href, "/avsec/entity-reports");
  assert.equal(deriveShellNav(model("operation_manager")).reports?.href, "/avsec/reports/lookup");
});

test("roles without any report destination simply have no Reports slot (never a dead or borrowed link)", () => {
  assert.equal(deriveShellNav(model("airasia_management")).reports?.href, "/avsec/reports/request-access");
  const unknown = deriveShellNav(model("definitely_not_a_role"));
  assert.equal(unknown.reports, null);
  assert.deepEqual(unknown.actions, []);
});

test("an unrecognised or empty identity fails closed to the minimum", () => {
  const none = deriveShellNav(buildNavModel({ roleCodes: [] }));
  assert.equal(none.home, null);
  assert.deepEqual(none.menu, []);
  const multi = deriveShellNav(buildNavModel({ roleCodes: ["aso", "maa_boss"] }));
  assert.ok(!multi.actions.length, "several distinct roles never merge their action menus");
});

test("entity and AOC separation is untouched: MAA and AAX models stay entity-scoped", () => {
  for (const role of ["maa_boss", "maa_admin", "aax_boss", "aax_admin"]) {
    const hrefs = shellHrefs(role);
    assert.ok(hrefs.includes("/avsec/entity-reports"));
    assert.ok(!hrefs.includes("/avsec/scan") && !hrefs.includes("/avsec/duty"));
  }
});

test("the Actions group never contains the dashboard or report entries (no duplicates inside the sheet)", () => {
  const s = deriveShellNav(model("aso", { canScan: true }));
  const hrefs = s.actions.flatMap((g) => g.items.map((i) => i.href));
  assert.ok(!hrefs.includes("/"));
  assert.equal(new Set(hrefs).size, hrefs.length);
});
