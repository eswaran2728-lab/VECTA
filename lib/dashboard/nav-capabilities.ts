/**
 * Explicit, canonical-role navigation model. ONE source for the desktop sidebar, the tablet/mobile drawer and the bottom tabs.
 *
 * The model is derived from the caller's ACTIVE canonical role assignments only. There is no default role: an unrecognised or
 * absent role yields a minimal "unknown" model (My Dashboard + Profile) -- it can never inherit another role's navigation.
 * Previously the layout substituted "ASO" for any role without a legacy compat rank, which showed Duty/Check-In/Leave/Overtime/
 * Timesheet to leadership accounts that have no roster.
 *
 * IMPORTANT: nothing here is authorization. It decides which LINKS are drawn. Every destination re-authorizes server-side
 * (requireRouteAccess / secure RPCs), so a hidden link is a convenience and a shown link that later redirects is still safe.
 */
import { LINK_HUB_CONFIG } from "./linkHubConfig.ts";
import { COMPAT_ROLE_BY_CANONICAL } from "../auth/compat-role-map.mjs";
import { NON_ROSTERED_LEADERSHIP_ROLES } from "../auth/non-rostered-roles.ts";

export type NavIcon =
  | "dashboard" | "shield" | "scan" | "plane" | "clock" | "calendar-check" | "calendar-days" | "coffee" | "file-text" | "search"
  | "message" | "megaphone" | "users" | "map-pin" | "sparkles" | "truck" | "package" | "activity" | "user" | "building" | "inbox";

export interface NavLink {
  href: string;
  label: string;
  icon: NavIcon;
  badge?: string;
  match?: string[];
}
export interface NavGroupModel {
  title: string;
  items: NavLink[];
}
export type NavKind =
  | "none"
  | "entity_boss"
  | "entity_admin"
  | "international"
  | "org_wide"
  | "supervisor"
  | "station_operator"
  | "unit_staff"
  | "caterlink_management"
  | "multi_role"
  | "unknown";

export interface NavModel {
  kind: NavKind;
  roleCode: string | null;
  groups: NavGroupModel[];
  /** Up to five primary tabs for the narrow bottom bar. */
  tabs: NavLink[];
  /** Capability flags (also asserted directly by tests). */
  duty: boolean;
  attendanceSelfService: boolean;
}

export const ENTITY_BOSS_ROLES = ["maa_boss", "aax_boss"] as const;
export const ENTITY_ADMIN_ROLES = ["maa_admin", "aax_admin"] as const;
export const ENTITY_LEADERSHIP_ROLES: readonly string[] = [...ENTITY_BOSS_ROLES, ...ENTITY_ADMIN_ROLES];
/** Roles with no roster: they never see Duty Terminal, Check In/Out, Leave, Overtime, Timesheet or any attendance mutation. */
export { NON_ROSTERED_LEADERSHIP_ROLES };
const INTERNATIONAL_ROLES = ["airasia_management", "ghod", "global_reporting_controller"];

const DASHBOARD: NavLink = { href: "/avsec/my-dashboard", label: "My Dashboard", icon: "dashboard" };
const PROFILE: NavLink = { href: "/avsec/profile", label: "Profile", icon: "user" };
const DISCUSSIONS: NavLink = { href: "/avsec/discussions", label: "Discussion Board", icon: "message", match: ["/avsec/discussions"] };
const FEEDBACK: NavLink = { href: "/avsec/feedback", label: "Anonymous Feedback", icon: "message" };
const BAY_BOARD: NavLink = { href: "/avsec/bay-board", label: "Bay Board", icon: "plane" };
const ENTITY_REPORTS: NavLink = { href: "/avsec/entity-reports", label: "Entity Reports", icon: "file-text", match: ["/avsec/entity-reports"] };
const STAFF_DIRECTORY: NavLink = { href: "/avsec/directory", label: "Staff Directory", icon: "users", match: ["/avsec/directory"] };
const REGISTRATIONS: NavLink = {
  href: "/avsec/admin/entity-registrations",
  label: "Registration Administration",
  icon: "inbox",
  match: ["/avsec/admin/entity-registrations"],
};
const ANNOUNCEMENTS: NavLink = { href: "/avsec/management/announcements", label: "Announcements", icon: "megaphone", match: ["/avsec/management/announcements"] };

/** The roster-based roles: exactly the canonical roles whose dashboard links to the duty terminal, plus the shift ranks. */
export const DUTY_ROLE_CODES: ReadonlySet<string> = new Set(
  Object.entries(LINK_HUB_CONFIG)
    .filter(([, cfg]) => cfg.links.some((l) => l.href === "/avsec/duty"))
    .map(([code]) => code),
);

function iconForHref(href: string, label: string): NavIcon {
  if (href.startsWith("/icms")) return "truck";
  if (href.includes("bay-board")) return "plane";
  if (href.includes("search") || href.includes("lookup")) return "search";
  if (href.includes("roster")) return "calendar-days";
  if (href.includes("absences")) return "coffee";
  if (href.includes("overtime")) return "clock";
  if (href.includes("duty")) return "clock";
  if (href.includes("reports") || href.includes("sec0") || /report/i.test(label)) return "file-text";
  return "activity";
}

function tabsFrom(items: NavLink[]): NavLink[] {
  return items.slice(0, 5);
}

/** Resolve which single canonical role the navigation reflects. Several distinct roles never merge silently. */
export function resolveNavRole(roleCodes: readonly string[], selectedRoleCode?: string | null): { roleCode: string | null; multi: boolean } {
  const distinct = [...new Set(roleCodes)];
  if (distinct.length === 0) return { roleCode: null, multi: false };
  if (selectedRoleCode && distinct.includes(selectedRoleCode)) return { roleCode: selectedRoleCode, multi: false };
  if (distinct.length === 1) return { roleCode: distinct[0], multi: false };
  return { roleCode: null, multi: true };
}

export function buildNavModel(input: { roleCodes: readonly string[]; selectedRoleCode?: string | null; canScan?: boolean }): NavModel {
  const { roleCode, multi } = resolveNavRole(input.roleCodes, input.selectedRoleCode);
  const none: NavModel = { kind: "none", roleCode: null, groups: [], tabs: [], duty: false, attendanceSelfService: false };
  if (input.roleCodes.length === 0) return none;

  if (multi) {
    const items = [DASHBOARD, DISCUSSIONS, PROFILE];
    return { kind: "multi_role", roleCode: null, groups: [{ title: "WORKSPACE", items }], tabs: items, duty: false, attendanceSelfService: false };
  }
  const code = roleCode as string;

  if (code === "caterlink_management") {
    const items: NavLink[] = [
      { href: "/icms/dashboard", label: "Operations Overview", icon: "dashboard" },
      { href: "/icms/transactions", label: "Live Transactions", icon: "truck" },
      { href: "/icms/incidents", label: "Incident Handling", icon: "shield" },
      { href: "/icms/admin/whitelists", label: "Whitelist Directory", icon: "users" },
      { href: "/icms/admin/archive", label: "Transaction Archive", icon: "file-text" },
      { href: "/icms/admin/audit", label: "Audit Log", icon: "activity" },
      { href: "/icms/reports", label: "Operational Reports", icon: "calendar-check" },
    ];
    return {
      kind: "caterlink_management",
      roleCode: code,
      groups: [{ title: "CATERLINK MANAGEMENT", items }, { title: "ACCOUNT", items: [PROFILE] }],
      tabs: tabsFrom([items[0], items[1], items[2], PROFILE]),
      duty: false,
      attendanceSelfService: false,
    };
  }

  if ((ENTITY_BOSS_ROLES as readonly string[]).includes(code) || (ENTITY_ADMIN_ROLES as readonly string[]).includes(code)) {
    const isAdmin = (ENTITY_ADMIN_ROLES as readonly string[]).includes(code);
    const reports: NavLink[] = [ENTITY_REPORTS, STAFF_DIRECTORY];
    if (isAdmin) reports.push(REGISTRATIONS);
    const groups: NavGroupModel[] = [
      { title: "ENTITY", items: [{ ...DASHBOARD, label: isAdmin ? "Entity Admin Overview" : "Entity Overview" }] },
      { title: isAdmin ? "ADMINISTRATION" : "REPORTS & STAFF", items: reports },
      { title: "OPERATIONS", items: [BAY_BOARD] },
      { title: "COMMUNICATION", items: [DISCUSSIONS, ANNOUNCEMENTS] },
      { title: "ACCOUNT", items: [PROFILE] },
    ];
    const tabs = tabsFrom([groups[0].items[0], ENTITY_REPORTS, STAFF_DIRECTORY, BAY_BOARD, PROFILE]);
    return { kind: isAdmin ? "entity_admin" : "entity_boss", roleCode: code, groups, tabs, duty: false, attendanceSelfService: false };
  }

  if (INTERNATIONAL_ROLES.includes(code)) {
    const cfg = LINK_HUB_CONFIG[code];
    const links: NavLink[] = (cfg?.links ?? []).map((l) => ({ href: l.href, label: l.label, icon: iconForHref(l.href, l.label) }));
    const comms: NavLink[] = [DISCUSSIONS];
    if (code === "ghod" || code === "airasia_management") comms.push(ANNOUNCEMENTS);
    const groups: NavGroupModel[] = [
      { title: "WORKSPACE", items: [DASHBOARD, ...links] },
      { title: "COMMUNICATION", items: comms },
      { title: "ACCOUNT", items: [PROFILE] },
    ];
    return { kind: "international", roleCode: code, groups, tabs: tabsFrom([DASHBOARD, ...links, PROFILE]), duty: false, attendanceSelfService: false };
  }

  const compat = (COMPAT_ROLE_BY_CANONICAL as Record<string, string | null>)[code];

  if (compat === "MANAGEMENT" || compat === "ENFORCEMENT") {
    // operation_manager / main_enforcement: org-wide supervisory ranks. No roster of their own.
    const ops: NavLink[] = [
      { href: "/avsec/dashboard", label: "Operations Dashboard", icon: "dashboard" },
      DASHBOARD,
      BAY_BOARD,
      { href: "/icms/transactions", label: "ICMS Catering Stream", icon: "activity" },
    ];
    const attendance: NavLink[] = [
      { href: "/avsec/admin/attendance-monitor", label: "Attendance & OT Monitor", icon: "calendar-check", badge: "MANAGEMENT" },
      { href: "/avsec/admin/absences", label: "Leave & Absence Audit", icon: "coffee" },
      { href: "/avsec/duty/overtime", label: "Overtime Management", icon: "clock" },
      { href: "/avsec/admin/roster", label: "Roster Management", icon: "calendar-days" },
    ];
    const reports: NavLink[] = [
      { href: "/avsec/reports/lookup", label: "Report Search & Lookup", icon: "search" },
      { href: "/?section=reports#reports", label: "File Security Report", icon: "file-text" },
    ];
    const comms: NavLink[] = [
      DISCUSSIONS,
      { href: "/avsec/management/feedback", label: "Staff Feedback Inbox", icon: "message" },
      { href: "/avsec/discussions/moderation", label: "Discussion Moderation", icon: "shield", match: ["/avsec/discussions/moderation"] },
    ];
    const groups: NavGroupModel[] = [
      { title: "OPERATIONS", items: ops },
      { title: "ATTENDANCE & ROSTER", items: attendance },
      { title: "SECURITY REPORTS", items: reports },
      { title: "COMMUNICATION", items: comms },
    ];
    if (compat === "MANAGEMENT") {
      groups.push({
        title: "ADMINISTRATION",
        items: [
          { href: "/avsec/admin/users", label: "User Directory", icon: "users" },
          { href: "/avsec/admin/zones", label: "Duty Geofence Zones", icon: "map-pin" },
        ],
      });
    }
    groups.push({ title: "ACCOUNT", items: [PROFILE] });
    return {
      kind: "org_wide",
      roleCode: code,
      groups,
      tabs: tabsFrom([ops[0], reports[0], DASHBOARD, PROFILE]),
      duty: false,
      attendanceSelfService: false,
    };
  }

  if (compat === "ASO" || compat === "SO" || compat === "DSE") {
    const isDse = compat === "DSE";
    const ops: NavLink[] = [
      { href: "/", label: "Operations Dashboard", icon: "dashboard" },
      DASHBOARD,
      { href: "/avsec/duty", label: "Duty Terminal & Check-In", icon: "clock" },
    ];
    if (input.canScan) ops.push({ href: "/avsec/scan", label: "Checkpoint Scanner", icon: "scan" });
    ops.push(BAY_BOARD);
    if (input.canScan) ops.push({ href: "/icms/transactions", label: "ICMS Catering Stream", icon: "activity" });
    const attendance: NavLink[] = isDse
      ? [
          { href: "/avsec/duty/absences", label: "Leave Approval Queue", icon: "coffee" },
          { href: "/avsec/duty/overtime", label: "OT Approval Queue", icon: "clock" },
        ]
      : [
          { href: "/avsec/duty/absences", label: "Apply & View Leaves", icon: "coffee" },
          { href: "/avsec/duty/overtime", label: "My Overtime Records", icon: "clock" },
          { href: "/avsec/duty/timesheet", label: "My Timesheet", icon: "calendar-days" },
        ];
    const groups: NavGroupModel[] = [
      { title: "OPERATIONS", items: ops },
      { title: "ATTENDANCE & ROSTER", items: attendance },
    ];
    if (isDse) groups.push({ title: "SECURITY REPORTS", items: [{ href: "/avsec/reports/lookup", label: "Report Search & Lookup", icon: "search" }] });
    groups.push({ title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] }, { title: "ACCOUNT", items: [PROFILE] });
    const tabs = input.canScan
      ? tabsFrom([{ href: "/", label: "Dashboard", icon: "dashboard" }, { href: "/avsec/scan", label: "Scan", icon: "scan" }, { href: "/icms/transactions", label: "Transaction History", icon: "activity", match: ["/icms/transactions"] }, BAY_BOARD, PROFILE])
      : tabsFrom([{ href: "/", label: "Dashboard", icon: "dashboard" }, BAY_BOARD, DASHBOARD, PROFILE]);
    return { kind: isDse ? "supervisor" : "station_operator", roleCode: code, groups, tabs, duty: true, attendanceSelfService: !isDse };
  }

  // Remaining unit roles (investigation / SAT / profiling / compliance): navigation comes from the role's own dashboard links.
  const cfg = LINK_HUB_CONFIG[code];
  if (cfg) {
    const links: NavLink[] = cfg.links.map((l) => ({ href: l.href, label: l.label, icon: iconForHref(l.href, l.label) }));
    const duty = DUTY_ROLE_CODES.has(code);
    const groups: NavGroupModel[] = [
      { title: "WORKSPACE", items: [DASHBOARD, ...links] },
      { title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] },
      { title: "ACCOUNT", items: [PROFILE] },
    ];
    return { kind: "unit_staff", roleCode: code, groups, tabs: tabsFrom([DASHBOARD, ...links, PROFILE]), duty, attendanceSelfService: false };
  }

  // Unknown role: fail closed to the bare minimum. Never inherit another role's navigation.
  return { kind: "unknown", roleCode: code, groups: [{ title: "WORKSPACE", items: [DASHBOARD, PROFILE] }], tabs: [DASHBOARD, PROFILE], duty: false, attendanceSelfService: false };
}

/** Every href a model exposes (used by tests to prove nav and route authorization agree). */
export function navHrefs(model: NavModel): string[] {
  return model.groups.flatMap((g) => g.items.map((i) => i.href));
}
