import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyFlightNumber, normalizeFlightNumber } from "../lib/avsec/flight-classification.ts";
import { announcementCapabilities } from "../lib/avsec/announcements/capabilities.ts";
import { reportViewHref } from "../lib/dashboard/entity-report-filters.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("AK/D7 matrix (mirrors the database classifier)", () => {
  const cases: Array<[string | null, string, string | null]> = [
    ["AK703", "classified", "MAA"],
    ["ak 703", "classified", "MAA"],
    ["AK-703", "classified", "MAA"],
    ["D7 123", "classified", "AAX"],
    ["d7123", "classified", "AAX"],
    ["D7123A", "classified", "AAX"],
    ["AK703/D7123", "conflict", null],
    ["AK703 D7123", "conflict", null],
    ["AK703 or D7123", "conflict", null],
    ["XX123", "unknown_prefix", null],
    ["", "missing", null],
    [null, "missing", null],
    ["FLIGHT", "malformed", null],
  ];
  for (const [raw, status, entity] of cases) {
    const c = classifyFlightNumber(raw);
    assert.equal(c.status, status, String(raw));
    assert.equal(c.entityCode, entity, String(raw));
  }
  assert.equal(normalizeFlightNumber(" ak-703 "), "AK703");
});

test("announcements: Global is GHOD only; Malaysia is the four entity roles; AirAsia Management is read-only", () => {
  assert.deepEqual(announcementCapabilities(["ghod"]), { mode: "manage", canManageGlobal: true, canManageMalaysia: false });
  for (const role of ["maa_boss", "maa_admin", "aax_boss", "aax_admin"]) {
    assert.deepEqual(announcementCapabilities([role]), { mode: "manage", canManageGlobal: false, canManageMalaysia: true }, role);
  }
  assert.equal(announcementCapabilities(["airasia_management"]).mode, "read_only");
  for (const role of ["super_admin", "operation_manager", "main_enforcement", "aso", "caterlink_management", "global_reporting_controller"]) {
    assert.equal(announcementCapabilities([role]).mode, "none", role);
  }
});

test("announcement page guard no longer depends on legacy rank lists or direct assignment-table reads", () => {
  const page = read("app/(avsec)/avsec/management/announcements/page.tsx");
  assert.doesNotMatch(page, /requireRole\(MANAGEMENT_ROLES\)|MANAGEMENT_ROLES/);
  assert.doesNotMatch(page, /from\("user_role_assignments"\)/);
  assert.match(page, /announcementCapabilities/);
});

test("GHOD flagged-report link uses the SOURCE id, never the repository id", () => {
  const dash = read("components/dashboard/ExecutiveDashboard.tsx");
  assert.match(dash, /reportViewHref\(r\.sourceTable, r\.sourceId\)/);
  assert.doesNotMatch(dash, /\$\{r\.id\}/);
  const agg = read("lib/dashboard/aggregates.ts");
  assert.match(agg, /sourceId: r\.source_id as string/);
  assert.equal(reportViewHref("report_sec016", "11111111-1111-1111-1111-111111111111"), "/avsec/reports/view/sec016/11111111-1111-1111-1111-111111111111");
});

test("identity reveal: Boss-only UI control, a dedicated audited RPC, no e-mail field", () => {
  const page = read("app/(avsec)/avsec/discussions/[id]/page.tsx");
  assert.match(page, /roleCodes\.includes\("maa_boss"\) \|\| roleCodes\.includes\("aax_boss"\)/);
  const actions = read("lib/discussions/actions.ts");
  assert.match(actions, /reveal_discussion_author_identity_secure/);
  const modal = read("components/discussions/IdentityResolutionModal.tsx");
  assert.match(modal, /mode === "moderator"/, "e-mail is rendered only for the existing moderator resolution");
  const view = read("components/discussions/ThreadDetailView.tsx");
  assert.match(view, /canBossReveal/);
});

test("nav: layout builds the explicit model and has no ASO fallback", () => {
  const layout = read("app/(avsec)/avsec/layout.tsx");
  assert.doesNotMatch(layout, /primaryCompatRole \?\? "ASO"/);
  assert.match(layout, /buildNavModel/);
  const bottom = read("components/layout/shell/MobileBottomNavigation.tsx");
  assert.match(bottom, /md:hidden/, "phones get the bottom bar; tablet and desktop get the rail");
  assert.doesNotMatch(bottom, /lg:hidden/);
});

test("nav: phones get Actions / Alerts / More sheets that are keyboard accessible; the rail covers tablet and desktop", () => {
  const sheet = read("components/layout/shell/BottomSheet.tsx");
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /Escape/);
  assert.match(sheet, /h-11 w-11/, "44px touch target");
  assert.match(read("components/layout/shell/MobileBottomNavigation.tsx"), /aria-expanded/);
  assert.match(read("components/layout/shell/DesktopNavigationRail.tsx"), /md:flex/);
  const header = read("components/layout/UnifiedHeader.tsx");
  assert.match(header, /menu\?: React\.ReactNode/);
});

test("bay board: entity roles get a hub + station selector backed by the secure RPCs", () => {
  const page = read("app/(avsec)/avsec/bay-board/page.tsx");
  assert.match(page, /EntityBayBoard/);
  const board = read("components/avsec/bay-board/EntityBayBoard.tsx");
  assert.match(board, /name="hub"/);
  assert.match(board, /name="station"/);
  assert.match(board, /role="status"|role="alert"/);
});

test("flight forms show the detected entity", () => {
  for (const f of ["Sec016Form", "Sec029Form", "OffloadForm"]) {
    assert.match(read(`components/avsec/forms/${f}.tsx`), /FlightEntityBadge/, f);
  }
});

test("attendance surface: non-rostered leadership is denied on every duty page and action (not only hidden from the menu)", async () => {
  const { isNonRosteredLeadership } = await import("../lib/auth/non-rostered-roles.ts");
  for (const role of ["maa_boss", "maa_admin", "aax_boss", "aax_admin", "airasia_management", "ghod", "global_reporting_controller", "super_admin"]) {
    assert.equal(isNonRosteredLeadership([role]), true, role);
  }
  for (const roles of [["aso"], ["hub_se"], ["operation_manager"], ["main_enforcement"], ["aso", "maa_boss"], []]) {
    assert.equal(isNonRosteredLeadership(roles), false, roles.join(","));
  }
  const pages = [
    "app/(avsec)/avsec/duty/absences/page.tsx",
    "app/(avsec)/avsec/duty/handover/page.tsx",
    "app/(avsec)/avsec/duty/handover/new/page.tsx",
    "app/(avsec)/avsec/duty/overtime/page.tsx",
    "app/(avsec)/avsec/duty/overtime/new/page.tsx",
    "app/(avsec)/avsec/duty/overtime/[id]/page.tsx",
    "app/(avsec)/avsec/duty/view/[id]/page.tsx",
    "app/(avsec)/avsec/duty/zones/page.tsx",
  ];
  for (const p of pages) {
    const src = read(p);
    assert.match(src, /requireAttendanceProfile\(\)/, p);
    assert.doesNotMatch(src, /\brequireProfile\(\)/, p);
  }
  for (const p of ["lib/avsec/duty/checkin-actions.ts", "lib/avsec/duty/absence-actions.ts", "lib/avsec/duty/overtime-actions.ts", "lib/avsec/duty/handover-actions.ts"]) {
    const src = read(p);
    assert.doesNotMatch(src, /\bgetCurrentProfile\(\)|\brequireProfile\(\)/, `${p} must use the attendance guards`);
  }
  // pages already gated by the canonical duty route policy
  assert.match(read("app/(avsec)/avsec/duty/page.tsx"), /requireRouteAccess\("\/avsec\/duty"/);
  assert.match(read("app/(avsec)/avsec/duty/timesheet/page.tsx"), /requireRouteAccess\("\/avsec\/duty"/);
});
