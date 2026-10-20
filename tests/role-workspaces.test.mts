import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLE_CAPABILITIES, capabilityFor, landsOnRoleDashboard, canActOnBayBoard, canViewBayBoard, canCreateReport } from "../lib/auth/role-capabilities.ts";
import { LINK_HUB_CONFIG } from "../lib/dashboard/linkHubConfig.ts";
import { isNonRosteredLeadership } from "../lib/auth/non-rostered-roles.ts";
import { buildNavModel, navHrefs } from "../lib/dashboard/nav-capabilities.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Roles whose my-dashboard component is a dedicated component (see app/(avsec)/avsec/my-dashboard/page.tsx). */
const DEDICATED = new Set(["executive", "super_admin", "entity_boss", "entity_admin", "operation_manager", "caterlink"]);

test("dashboard resolver: EVERY canonical role resolves to a dedicated component or a configured link hub (no fallthrough)", () => {
  for (const [code, cap] of Object.entries(ROLE_CAPABILITIES)) {
    if (DEDICATED.has(cap.dashboard)) continue;
    assert.ok(LINK_HUB_CONFIG[code], `${code} (${cap.dashboard}) needs a link-hub configuration`);
  }
  const page = read("app/(avsec)/avsec/my-dashboard/page.tsx");
  for (const kind of ["executive", "super_admin", "entity_boss", "entity_admin", "operation_manager"]) assert.match(page, new RegExp(`kind === "${kind}"`));
  assert.match(page, /capabilityFor\(roleCode\)\?\.dashboard/);
});

test("landing: Operation Manager, Main Enforcement and Hub SE land on their OWN workspace, not the legacy rank dashboard", () => {
  for (const role of ["operation_manager", "main_enforcement", "hub_se"]) assert.equal(landsOnRoleDashboard([role]), true, role);
  for (const role of ["aso", "so", "sso", "dse"]) assert.equal(landsOnRoleDashboard([role]), false, role);
  assert.match(read("app/page.tsx"), /landsOnRoleDashboard\(access\.roleCodes\)\) redirect\("\/avsec\/my-dashboard"\)/);
});

test("Bay Board: leadership read-only with selectors, rostered staff act, everyone else is refused (page AND server actions)", () => {
  for (const role of ["maa_boss", "aax_admin", "operation_manager", "main_enforcement"]) {
    assert.equal(canViewBayBoard([role]), true, role);
    assert.equal(canActOnBayBoard([role]), false, `${role} must not add/clear aircraft`);
  }
  for (const role of ["aso", "so", "sso", "dse", "hub_se", "sat_aso", "profiling_so", "profiling_aso"]) assert.equal(canActOnBayBoard([role]), true, role);
  for (const role of ["compliance", "investigation_so", "ghod", "airasia_management", "global_reporting_controller"]) assert.equal(canViewBayBoard([role]), false, role);
  const actions = read("lib/avsec/reports/actions.ts");
  assert.match(actions, /requireProfileId\("bayboard"\)/);
  assert.equal((actions.match(/requireProfileId\("bayboard"\)/g) ?? []).length, 2, "add AND clear are guarded");
});

test("report forms: every submit action names its form type and the role table decides", () => {
  const actions = read("lib/avsec/reports/actions.ts");
  for (const [fn, type] of [["submitSec016", "sec016"], ["submitSec014", "sec014"], ["submitSec029", "sec029"], ["submitSec018", "sec018"], ["submitSec033", "sec033"], ["submitSec013", "sec013"], ["submitOffload", "offload"]]) {
    assert.match(actions, new RegExp(`export async function ${fn}\\(input: unknown\\): Promise<ActionResult> \\{\\n  const profile = await requireProfileId\\("${type}"\\)`), fn);
  }
  assert.equal(canCreateReport(["profiling_so"], "sec013"), false, "Profiling SO has no report-creation action");
  assert.equal(canCreateReport(["profiling_aso"], "sec013"), true);
  assert.equal(canCreateReport(["sso"], "sec016"), false);
  assert.match(read("app/(avsec)/avsec/reports/sec013/page.tsx"), /requireRouteAccess\("\/avsec\/reports\/sec013", \[\]\)/);
});

test("Compliance and Investigation: no attendance, no report creation, no CaterLink actions (server rule, not only menu)", () => {
  for (const role of ["compliance", "investigation_sso", "investigation_so", "investigation_aso"]) {
    assert.equal(isNonRosteredLeadership([role]), true, role);
    for (const type of ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "offload"] as const) assert.equal(canCreateReport([role], type), false, `${role} ${type}`);
    assert.ok(!navHrefs(buildNavModel({ roleCodes: [role], canScan: true })).some((h) => h.startsWith("/icms") || h === "/avsec/scan"), role);
  }
});

test("Investigation is non-rostered because the repository says so (documented evidence, with the decision flagged)", () => {
  const sql = read("supabase/migrations/20260930000001_phase8_operational_workflows.sql");
  assert.match(sql, /Investigation is Malaysia-wide and has no station\/team roster/);
  assert.match(read("docs/dashboard-review/role-workspace-correction.md"), /Investigation roster evidence/);
});

test("GRC workspace: the page, the RPCs and the route policy agree", () => {
  const page = read("app/(avsec)/avsec/reports/requests/page.tsx");
  assert.match(page, /requireRouteAccess\("\/avsec\/reports\/requests", \[\]\)/);
  const sql = read("supabase/migrations/20261102000001_role_workspace_support.sql");
  for (const fn of ["list_report_access_requests_secure", "list_report_access_grants_secure", "list_report_access_audit_secure", "reject_report_access_request"]) {
    assert.match(sql, new RegExp(`function public\\.${fn}`));
  }
  assert.equal(
    Object.entries(LINK_HUB_CONFIG).filter(([, c]) => c.links.some((l) => l.href === "/avsec/reports/requests")).map(([k]) => k).join(),
    "global_reporting_controller",
    "only the Global Reporting Controller is linked to the request queue",
  );
  assert.doesNotMatch(read("lib/avsec/reports/grc.ts"), /\.select\(\s*"content"/, "no content selection");
});

test("every role migration function is least-privilege: fixed search_path and PUBLIC/anon revoked", () => {
  for (const f of ["20261102000001_role_workspace_support.sql", "20261102000002_entity_staff_maintenance.sql"]) {
    const sql = read(`supabase/migrations/${f}`);
    const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    for (const fn of fns) {
      if (fn === "derive_report_classification" || fn === "enforce_profile_self_update") continue; // trigger functions: no direct EXECUTE grant
      assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`), `${f}: ${fn} must revoke PUBLIC/anon`);
    }
    for (const body of sql.split(/create or replace function /).slice(1)) assert.match(body.slice(0, 600), /set search_path to 'public'/, `${f}: fixed search_path`);
  }
});

test("capability table: SSO and SO are distinct identities; Hub SE is not DSE", () => {
  assert.notEqual(capabilityFor("sso")?.label, capabilityFor("so")?.label);
  assert.notEqual(capabilityFor("hub_se")?.label, capabilityFor("dse")?.label);
  assert.equal(capabilityFor("hub_se")?.dashboard, "hub");
});
