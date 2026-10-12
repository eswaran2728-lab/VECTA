/**
 * THE canonical, server-side role capability definition. Navigation (lib/dashboard/nav-capabilities.ts), the dashboard resolver
 * (/avsec/my-dashboard), the display labels and the attendance / report-form guards all read THIS table, so they can never disagree.
 * Pure (no framework imports): unit-testable and importable from the edge middleware and from node tests.
 *
 * Nothing here replaces database authorization. It decides what a role is SHOWN and which server-action doors are even attempted;
 * every RPC, RLS policy, Storage policy and export re-checks the caller (approved profile, active in-window assignment, exact scope).
 * An unknown role code has NO entry and therefore no capability (fail closed) -- there is no default role.
 */
export type ReportFormType = "sec013" | "sec014" | "sec016" | "sec018" | "sec029" | "sec033" | "offload";

export type DashboardKind =
  | "executive" // AirAsia Management, GHOD
  | "grc" // Global Reporting Controller
  | "super_admin"
  | "entity_boss"
  | "entity_admin"
  | "operation_manager"
  | "enforcement" // Main Enforcement
  | "investigation"
  | "compliance"
  | "link_hub" // station / unit staff: role dashboard
  | "hub"
  | "caterlink";

export type BayBoardMode = "none" | "actions" | "read_only_selector";

export interface RoleCapability {
  code: string;
  /** Exact display label. Never a legacy label such as MANAGEMENT / DSE for an unrelated role. */
  label: string;
  dashboard: DashboardKind;
  /** Has a personal roster: Duty Terminal / Check In-Out, personal Leave, personal Overtime, Timesheet. */
  rostered: boolean;
  bayBoard: BayBoardMode;
  /** Report forms this role may CREATE (server actions enforce this; there is no "all forms" default). */
  reportForms: readonly ReportFormType[];
}

const STANDARD_ASO_FORMS: readonly ReportFormType[] = ["sec016", "sec014", "sec029", "sec018", "sec033", "offload"];

const t = (
  code: string,
  label: string,
  dashboard: DashboardKind,
  o: Partial<Pick<RoleCapability, "rostered" | "bayBoard" | "reportForms">> = {},
): RoleCapability => ({ code, label, dashboard, rostered: false, bayBoard: "none", reportForms: [], ...o });

export const ROLE_CAPABILITIES: Readonly<Record<string, RoleCapability>> = Object.fromEntries(
  [
    // Global / platform
    t("airasia_management", "AirAsia Management", "executive"),
    t("ghod", "GHOD", "executive"),
    t("global_reporting_controller", "Global Reporting Controller", "grc"),
    t("super_admin", "Super Admin", "super_admin"),
    // Malaysia entity leadership (read-only Bay Board with hub + station selector)
    t("maa_boss", "MAA Boss", "entity_boss", { bayBoard: "read_only_selector" }),
    t("aax_boss", "AAX Boss", "entity_boss", { bayBoard: "read_only_selector" }),
    t("maa_admin", "MAA Admin", "entity_admin", { bayBoard: "read_only_selector" }),
    t("aax_admin", "AAX Admin", "entity_admin", { bayBoard: "read_only_selector" }),
    // Malaysia department leadership (oversight; no personal roster)
    t("operation_manager", "Operation Manager", "operation_manager", { bayBoard: "read_only_selector" }),
    t("main_enforcement", "Main Enforcement", "enforcement", { bayBoard: "read_only_selector" }),
    t("compliance", "Compliance", "compliance"),
    // Investigation: Malaysia-wide, no station/team roster (supabase/migrations/20260930000001_phase8_operational_workflows.sql, "Investigation is Malaysia-wide and has no station/team roster")
    t("investigation_sso", "Investigation SSO", "investigation"),
    t("investigation_so", "Investigation SO", "investigation"),
    t("investigation_aso", "Investigation ASO", "investigation"),
    // Rostered unit staff
    t("sat_aso", "SAT ASO", "link_hub", { rostered: true, bayBoard: "actions" }),
    t("profiling_so", "Profiling SO", "link_hub", { rostered: true, bayBoard: "actions" }),
    t("profiling_aso", "Profiling ASO", "link_hub", { rostered: true, bayBoard: "actions", reportForms: ["sec013"] }),
    // Operation hierarchy
    t("hub_se", "Hub SE", "hub", { rostered: true, bayBoard: "actions" }),
    t("dse", "DSE", "link_hub", { rostered: true, bayBoard: "actions" }),
    t("sso", "SSO", "link_hub", { rostered: true, bayBoard: "actions" }),
    t("so", "SO", "link_hub", { rostered: true, bayBoard: "actions" }),
    t("aso", "ASO", "link_hub", { rostered: true, bayBoard: "actions", reportForms: STANDARD_ASO_FORMS }),
    // CaterLink (own portal; no VECTA workspace)
    t("caterlink_management", "CaterLink Management", "caterlink"),
  ].map((c) => [c.code, c]),
);

export function capabilityFor(roleCode: string | null | undefined): RoleCapability | null {
  return roleCode ? (ROLE_CAPABILITIES[roleCode] ?? null) : null;
}

/** Exact label for a role code, or null when the role is unknown (never a guessed or legacy label). */
export function roleLabelFor(roleCode: string | null | undefined): string | null {
  return capabilityFor(roleCode)?.label ?? null;
}

/** The highest-seniority label for a profile holding several roles (display only). */
const LABEL_PRECEDENCE = [
  "super_admin", "airasia_management", "ghod", "global_reporting_controller", "maa_boss", "aax_boss", "maa_admin", "aax_admin",
  "operation_manager", "main_enforcement", "compliance", "caterlink_management", "hub_se", "dse", "sso", "so", "aso",
  "investigation_sso", "investigation_so", "investigation_aso", "sat_aso", "profiling_so", "profiling_aso",
];
export function primaryRoleLabel(roleCodes: readonly string[]): string | null {
  for (const code of LABEL_PRECEDENCE) if (roleCodes.includes(code)) return roleLabelFor(code);
  return null;
}

export function isRostered(roleCode: string | null | undefined): boolean {
  return capabilityFor(roleCode)?.rostered === true;
}

/**
 * Personal attendance surfaces (Duty Terminal, Check In/Out, personal Leave, personal Overtime, Timesheet) are denied when the caller
 * holds roles and NONE of them is rostered OR an oversight role that legitimately works the shared approval queues.
 * Oversight roles keep the shared Leave / Overtime pages (they approve, they do not apply): operation_manager, main_enforcement.
 */
const ATTENDANCE_OVERSIGHT_ROLES = new Set(["operation_manager", "main_enforcement"]);
export function mayUseAttendanceSurface(roleCodes: readonly string[]): boolean {
  if (roleCodes.length === 0) return false;
  return roleCodes.some((c) => isRostered(c) || ATTENDANCE_OVERSIGHT_ROLES.has(c));
}

/**
 * Roles whose landing page is their dedicated role dashboard (/avsec/my-dashboard) instead of the legacy rank dashboard
 * (/avsec/home, /avsec/dashboard). Operation Manager and Main Enforcement used to land on the generic legacy management dashboard,
 * and Hub SE on the generic DSE one; they now get their own workspace.
 */
const ROLE_DASHBOARD_LANDING = new Set<DashboardKind>(["operation_manager", "enforcement", "hub"]);
export function landsOnRoleDashboard(roleCodes: readonly string[]): boolean {
  for (const code of LABEL_PRECEDENCE) {
    if (roleCodes.includes(code)) return ROLE_DASHBOARD_LANDING.has(ROLE_CAPABILITIES[code]?.dashboard as DashboardKind);
  }
  return false;
}

/** Operational Bay Board actions (add / clear an aircraft). Entity leaders and oversight roles get a READ-ONLY board; Compliance etc. none. */
export function canActOnBayBoard(roleCodes: readonly string[]): boolean {
  return roleCodes.some((c) => capabilityFor(c)?.bayBoard === "actions");
}
export function canViewBayBoard(roleCodes: readonly string[]): boolean {
  return roleCodes.some((c) => (capabilityFor(c)?.bayBoard ?? "none") !== "none");
}

export function canCreateReport(roleCodes: readonly string[], type: ReportFormType): boolean {
  return roleCodes.some((c) => capabilityFor(c)?.reportForms.includes(type) === true);
}
