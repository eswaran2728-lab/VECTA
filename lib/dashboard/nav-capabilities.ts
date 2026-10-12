/**
 * Explicit, canonical-role navigation model. ONE source for the desktop sidebar, the tablet/mobile drawer and the bottom tabs.
 * Derived from the caller's ACTIVE canonical role assignments only and from the single capability table
 * (lib/auth/role-capabilities.ts). There is no default role: an unrecognised role gets My Dashboard + Profile and nothing else.
 *
 * IMPORTANT: nothing here is authorization. It decides which LINKS are drawn. Every destination re-authorizes server-side
 * (requireRouteAccess / requirePhase8Role / secure RPCs), so a hidden link is a convenience, never a control.
 */
import { LINK_HUB_CONFIG } from "./linkHubConfig.ts";
import { capabilityFor, roleLabelFor } from "../auth/role-capabilities.ts";
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
  | "executive"
  | "grc"
  | "operation_manager"
  | "enforcement"
  | "investigation"
  | "compliance"
  | "supervisor"
  | "hub"
  | "station_operator"
  | "unit_staff"
  | "caterlink_management"
  | "multi_role"
  | "unknown";

export interface NavModel {
  kind: NavKind;
  roleCode: string | null;
  /** Exact role label (never a legacy label). */
  roleLabel: string | null;
  groups: NavGroupModel[];
  /** Up to five primary tabs for the narrow bottom bar. */
  tabs: NavLink[];
  duty: boolean;
  attendanceSelfService: boolean;
}

export const ENTITY_BOSS_ROLES = ["maa_boss", "aax_boss"] as const;
export const ENTITY_ADMIN_ROLES = ["maa_admin", "aax_admin"] as const;
export const ENTITY_LEADERSHIP_ROLES: readonly string[] = [...ENTITY_BOSS_ROLES, ...ENTITY_ADMIN_ROLES];
export { NON_ROSTERED_LEADERSHIP_ROLES };

const L = (href: string, label: string, icon: NavIcon, extra: Partial<NavLink> = {}): NavLink => ({ href, label, icon, ...extra });

const DASHBOARD = L("/avsec/my-dashboard", "My Dashboard", "dashboard");
const PROFILE = L("/avsec/profile", "Profile", "user");
const DISCUSSIONS = L("/avsec/discussions", "Discussion Board", "message", { match: ["/avsec/discussions"] });
const FEEDBACK = L("/avsec/feedback", "Anonymous Feedback", "message");
const BAY_BOARD = L("/avsec/bay-board", "Bay Board", "plane");
const BAY_BOARD_RO = L("/avsec/bay-board", "Bay Board (read-only)", "plane");
const REPORT_SEARCH = L("/avsec/reports/lookup", "Report Search", "search");
const ENTITY_REPORTS = L("/avsec/entity-reports", "Entity Reports", "file-text", { match: ["/avsec/entity-reports"] });
const STAFF_DIRECTORY = L("/avsec/directory", "Staff Directory", "users", { match: ["/avsec/directory"] });
const REGISTRATIONS = L("/avsec/admin/entity-registrations", "Registration Administration", "inbox", { match: ["/avsec/admin/entity-registrations"] });
const ENTITY_STAFF = L("/avsec/admin/entity-staff", "Staff Accounts", "users", { match: ["/avsec/admin/entity-staff"] });
const ANNOUNCEMENTS = L("/avsec/management/announcements", "Announcements", "megaphone", { match: ["/avsec/management/announcements"] });
const DUTY = L("/avsec/duty", "Duty Terminal & Check-In", "clock");
const LEAVES_MINE = L("/avsec/duty/absences", "Apply & View Leaves", "coffee");
const OT_MINE = L("/avsec/duty/overtime", "My Overtime Records", "clock");
const TIMESHEET = L("/avsec/duty/timesheet", "My Timesheet", "calendar-days");
const LEAVE_QUEUE = L("/avsec/duty/absences", "Leave Approval Queue", "coffee");
const OT_QUEUE = L("/avsec/duty/overtime", "OT Approval Queue", "clock");
const ROSTER = L("/avsec/admin/roster", "Roster", "calendar-days");

/** Personal attendance block for rostered, non-supervising staff. */
const SELF_ATTENDANCE: NavLink[] = [LEAVES_MINE, OT_MINE, TIMESHEET];

const tabsFrom = (items: NavLink[]): NavLink[] => items.slice(0, 5);

/** Resolve which single canonical role the navigation reflects. Several distinct roles never merge silently. */
export function resolveNavRole(roleCodes: readonly string[], selectedRoleCode?: string | null): { roleCode: string | null; multi: boolean } {
  const distinct = [...new Set(roleCodes)];
  if (distinct.length === 0) return { roleCode: null, multi: false };
  if (selectedRoleCode && distinct.includes(selectedRoleCode)) return { roleCode: selectedRoleCode, multi: false };
  if (distinct.length === 1) return { roleCode: distinct[0], multi: false };
  return { roleCode: null, multi: true };
}

function model(kind: NavKind, code: string, groups: NavGroupModel[], tabs: NavLink[], duty = false, attendanceSelfService = false): NavModel {
  return { kind, roleCode: code, roleLabel: roleLabelFor(code), groups, tabs: tabsFrom(tabs), duty, attendanceSelfService };
}

export function buildNavModel(input: { roleCodes: readonly string[]; selectedRoleCode?: string | null; canScan?: boolean }): NavModel {
  const { roleCode, multi } = resolveNavRole(input.roleCodes, input.selectedRoleCode);
  if (input.roleCodes.length === 0) return { kind: "none", roleCode: null, roleLabel: null, groups: [], tabs: [], duty: false, attendanceSelfService: false };

  if (multi) {
    const items = [DASHBOARD, DISCUSSIONS, PROFILE];
    return { kind: "multi_role", roleCode: null, roleLabel: null, groups: [{ title: "WORKSPACE", items }], tabs: items, duty: false, attendanceSelfService: false };
  }
  const code = roleCode as string;
  const cap = capabilityFor(code);

  // Unknown role: fail closed to the bare minimum. Never inherit another role's navigation.
  if (!cap) {
    return { kind: "unknown", roleCode: code, roleLabel: null, groups: [{ title: "WORKSPACE", items: [DASHBOARD, PROFILE] }], tabs: [DASHBOARD, PROFILE], duty: false, attendanceSelfService: false };
  }

  switch (code) {
    case "caterlink_management": {
      const items = [
        L("/icms/dashboard", "Operations Overview", "dashboard"),
        L("/icms/transactions", "Live Transactions", "truck"),
        L("/icms/incidents", "Incident Handling", "shield"),
        L("/icms/admin/whitelists", "Whitelist Directory", "users"),
        L("/icms/admin/archive", "Transaction Archive", "file-text"),
        L("/icms/admin/audit", "Audit Log", "activity"),
        L("/icms/reports", "Operational Reports", "calendar-check"),
      ];
      return model("caterlink_management", code, [{ title: "CATERLINK MANAGEMENT", items }, { title: "ACCOUNT", items: [PROFILE] }], [items[0], items[1], items[2], PROFILE]);
    }

    case "maa_boss":
    case "aax_boss":
    case "maa_admin":
    case "aax_admin": {
      const isAdmin = code.endsWith("_admin");
      const reports: NavLink[] = [ENTITY_REPORTS, STAFF_DIRECTORY];
      if (isAdmin) reports.push(REGISTRATIONS, ENTITY_STAFF);
      const overview = L("/avsec/my-dashboard", isAdmin ? "Entity Admin Overview" : "Entity Overview", "dashboard");
      return model(
        isAdmin ? "entity_admin" : "entity_boss",
        code,
        [
          { title: "ENTITY", items: [overview] },
          { title: isAdmin ? "ADMINISTRATION" : "REPORTS & STAFF", items: reports },
          { title: "OPERATIONS", items: [BAY_BOARD_RO] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, ANNOUNCEMENTS] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, ENTITY_REPORTS, STAFF_DIRECTORY, BAY_BOARD_RO, PROFILE],
      );
    }

    case "airasia_management": {
      const overview = L("/avsec/my-dashboard", "Executive Overview", "dashboard");
      return model(
        "executive",
        code,
        [
          { title: "EXECUTIVE", items: [overview] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, L("/avsec/management/announcements", "Announcements (read-only)", "megaphone")] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, DISCUSSIONS, PROFILE],
      );
    }

    case "ghod": {
      const overview = L("/avsec/my-dashboard", "Executive Overview", "dashboard");
      return model(
        "executive",
        code,
        [
          { title: "EXECUTIVE", items: [overview, L("/avsec/my-dashboard#flagged-reports", "Flagged Reports", "shield")] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, L("/avsec/management/announcements", "Global Announcements", "megaphone", { match: ["/avsec/management/announcements"] })] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, DISCUSSIONS, PROFILE],
      );
    }

    case "global_reporting_controller": {
      const overview = L("/avsec/my-dashboard", "Reporting Overview", "dashboard");
      const requests = L("/avsec/reports/requests", "Report Requests", "inbox", { match: ["/avsec/reports/requests"] });
      const grants = L("/avsec/reports/requests?view=grants", "Grants & Expiry", "shield");
      const audit = L("/avsec/reports/requests?view=audit", "Export & Access Audit", "activity");
      return model(
        "grc",
        code,
        [
          { title: "REPORTING", items: [overview, REPORT_SEARCH, requests, grants, audit] },
          { title: "COMMUNICATION", items: [DISCUSSIONS] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, REPORT_SEARCH, requests, PROFILE],
      );
    }

    case "operation_manager": {
      const overview = L("/avsec/my-dashboard", "Operation Overview", "dashboard");
      return model(
        "operation_manager",
        code,
        [
          { title: "OPERATIONS", items: [overview, BAY_BOARD_RO, L("/avsec/operation/duty-draw", "Duty Draw", "sparkles")] },
          {
            title: "ATTENDANCE & ROSTER",
            items: [
              L("/avsec/admin/attendance-monitor", "Attendance & OT Monitor", "calendar-check"),
              L("/avsec/admin/absences", "Leave & Absence Audit", "coffee"),
              L("/avsec/duty/overtime", "Overtime Approvals", "clock"),
              L("/avsec/admin/roster", "Roster Oversight", "calendar-days"),
              L("/avsec/admin/zones", "Duty Geofence Zones", "map-pin"),
              L("/avsec/admin/attendance-report", "Attendance Report & Export", "file-text"),
            ],
          },
          { title: "REPORTS", items: [REPORT_SEARCH, L("/icms/transactions", "CaterLink Movements (read-only)", "truck")] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, L("/avsec/discussions/moderation", "Discussion Moderation", "shield", { match: ["/avsec/discussions/moderation"] })] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, L("/avsec/admin/attendance-monitor", "Attendance", "calendar-check"), REPORT_SEARCH, BAY_BOARD_RO, PROFILE],
      );
    }

    case "main_enforcement": {
      const overview = L("/avsec/my-dashboard", "Enforcement Overview", "dashboard");
      const workforce = L("/avsec/enforcement/workforce", "SAT & Profiling Workforce", "users");
      const cases = L("/avsec/investigation/cases", "Investigation Cases", "file-text", { match: ["/avsec/investigation/cases"] });
      const sat = L("/avsec/sat/reports", "SAT Combined Reports", "file-text");
      const search = L("/avsec/enforcement/search", "Enforcement Search", "search");
      return model(
        "enforcement",
        code,
        [
          { title: "ENFORCEMENT", items: [overview, search, REPORT_SEARCH, workforce, cases, sat] },
          { title: "COMMUNICATION", items: [DISCUSSIONS] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, search, workforce, cases, PROFILE],
      );
    }

    case "investigation_sso":
    case "investigation_so":
    case "investigation_aso": {
      const overview = L("/avsec/my-dashboard", "Investigation Overview", "dashboard");
      const cases = L("/avsec/investigation/cases", "Case Workspace", "file-text", { match: ["/avsec/investigation/cases"] });
      const search = L("/avsec/enforcement/search", "Enforcement Search", "search");
      return model(
        "investigation",
        code,
        [
          { title: "INVESTIGATION", items: [overview, cases, REPORT_SEARCH, search, L("/avsec/sat/reports", "SAT Combined Reports (read-only)", "file-text")] },
          { title: "COMMUNICATION", items: [DISCUSSIONS] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, cases, REPORT_SEARCH, PROFILE],
      );
    }

    case "compliance": {
      const overview = L("/avsec/my-dashboard", "Compliance Overview", "dashboard");
      const flights = L("/avsec/flights", "Flight Dashboard (read-only)", "plane");
      return model(
        "compliance",
        code,
        [
          { title: "COMPLIANCE (READ-ONLY)", items: [overview, REPORT_SEARCH, flights] },
          { title: "COMMUNICATION", items: [DISCUSSIONS] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [overview, REPORT_SEARCH, flights, PROFILE],
      );
    }

    case "hub_se": {
      const hub = L("/avsec/my-dashboard", "Hub Dashboard", "dashboard");
      return model(
        "hub",
        code,
        [
          { title: "HUB", items: [hub, DUTY, BAY_BOARD, ROSTER, REPORT_SEARCH] },
          { title: "ATTENDANCE & APPROVALS", items: [LEAVE_QUEUE, OT_QUEUE, TIMESHEET] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [hub, DUTY, ROSTER, BAY_BOARD, PROFILE],
        true,
        false,
      );
    }

    case "dse": {
      const dash = L("/", "Dashboard", "dashboard");
      const ops = [dash, DUTY];
      if (input.canScan) ops.push(L("/avsec/scan", "Checkpoint Scanner", "scan"));
      ops.push(BAY_BOARD, ROSTER);
      return model(
        "supervisor",
        code,
        [
          { title: "OPERATIONS", items: ops },
          { title: "ATTENDANCE & APPROVALS", items: [LEAVE_QUEUE, OT_QUEUE, TIMESHEET] },
          { title: "SECURITY REPORTS", items: [REPORT_SEARCH] },
          { title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [dash, DUTY, ROSTER, BAY_BOARD, PROFILE],
        true,
        false,
      );
    }

    case "aso":
    case "so":
    case "sso": {
      const dash = L("/", "Dashboard", "dashboard");
      const ops = [dash, DUTY];
      if (input.canScan) ops.push(L("/avsec/scan", "Checkpoint Scanner", "scan"));
      ops.push(BAY_BOARD);
      if (input.canScan) ops.push(L("/icms/transactions", "ICMS Catering Stream", "activity", { match: ["/icms/transactions"] }));
      const groups: NavGroupModel[] = [
        { title: "OPERATIONS", items: ops },
        { title: "ATTENDANCE", items: SELF_ATTENDANCE },
      ];
      if (code !== "aso") groups.push({ title: "SECURITY REPORTS", items: [REPORT_SEARCH] });
      groups.push({ title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] }, { title: "ACCOUNT", items: [PROFILE] });
      const tabs = input.canScan
        ? [dash, L("/avsec/scan", "Scan", "scan"), L("/icms/transactions", "Transaction History", "activity", { match: ["/icms/transactions"] }), BAY_BOARD, PROFILE]
        : [dash, DUTY, BAY_BOARD, PROFILE];
      return model("station_operator", code, groups, tabs, true, true);
    }

    case "sat_aso":
    case "profiling_so":
    case "profiling_aso": {
      const dash = L("/avsec/my-dashboard", "My Dashboard", "dashboard");
      const work: NavLink[] =
        code === "sat_aso"
          ? [L("/avsec/sat/reports", "SAT Combined Daily PDF", "file-text")]
          : code === "profiling_aso"
            ? [L("/avsec/reports/sec013", "SEC013 Profiling Report", "file-text"), L("/avsec/profiling/workspace", "Profiling Workspace", "activity")]
            : [L("/avsec/profiling/workspace", "SEC013 Acknowledgement Queue", "inbox")];
      return model(
        "unit_staff",
        code,
        [
          { title: "WORKSPACE", items: [dash, DUTY, BAY_BOARD, ...work] },
          { title: "ATTENDANCE", items: SELF_ATTENDANCE },
          { title: "COMMUNICATION", items: [DISCUSSIONS, FEEDBACK] },
          { title: "ACCOUNT", items: [PROFILE] },
        ],
        [dash, DUTY, BAY_BOARD, ...work.slice(0, 1), PROFILE],
        true,
        true,
      );
    }
  }

  // A role with a capability row but no navigation case above: minimum only (kept explicit so a new role cannot inherit another's menu).
  const cfg = LINK_HUB_CONFIG[code];
  const extra = (cfg?.links ?? []).filter((l) => l.href !== "/avsec/duty").map((l) => L(l.href, l.label, "activity"));
  return model("unknown", code, [{ title: "WORKSPACE", items: [DASHBOARD, ...extra, PROFILE] }], [DASHBOARD, PROFILE]);
}

/** Every href a model exposes (used by tests to prove nav and route authorization agree). */
export function navHrefs(model: NavModel): string[] {
  return model.groups.flatMap((g) => g.items.map((i) => i.href.split("#")[0].split("?")[0]));
}
