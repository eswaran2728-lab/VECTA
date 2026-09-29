/**
 * Pure config for the Phase 7 "composed, not rebuilt" dashboards
 * (GenericLinkHubDashboard) -- no server imports, so it can be unit-tested
 * directly. Every link points at an EXISTING, already-authorized route;
 * this file introduces no new authorization decision.
 */
export interface HubLink {
  href: string;
  label: string;
}

export interface LinkHubDashboardConfig {
  title: string;
  subtitle: string;
  links: HubLink[];
  showReportCounts?: boolean;
  showStaffing?: boolean;
  showHubBreakdown?: boolean;
}

const REPORT_SEARCH: HubLink = { href: "/avsec/reports/lookup", label: "Report Search" };
const ENFORCEMENT_SEARCH: HubLink = { href: "/avsec/enforcement/search", label: "Enforcement Search" };
const BAY_BOARD: HubLink = { href: "/avsec/bay-board", label: "Bay Board" };
const DUTY: HubLink = { href: "/avsec/duty", label: "Duty Terminal & Check-In" };
const ABSENCES: HubLink = { href: "/avsec/duty/absences", label: "Leave" };
const OVERTIME: HubLink = { href: "/avsec/duty/overtime", label: "OT" };
const ROSTER: HubLink = { href: "/avsec/admin/roster", label: "Roster" };
const SEC013: HubLink = { href: "/avsec/reports/sec013", label: "SEC013 (Profiling)" };
const ICMS_DASHBOARD: HubLink = { href: "/icms/dashboard", label: "CaterLink Overview" };
const ICMS_TRANSACTIONS: HubLink = { href: "/icms/transactions", label: "Transactions" };
const ICMS_INCIDENTS: HubLink = { href: "/icms/incidents", label: "Incidents" };
const ICMS_WHITELIST: HubLink = { href: "/icms/admin/whitelists", label: "Whitelist" };
const ICMS_ARCHIVE: HubLink = { href: "/icms/admin/archive", label: "Archive" };
const EXPORT_ENTRY: HubLink = { href: "/avsec/dashboard", label: "Export / Filters" };

/** Roles that never get a checkpoint scanner link from this dashboard --
 *  asserted directly by a unit test (Phase 7 spec: "Profiling has NO
 *  checkpoint scanner/navigation"). The scanner route itself
 *  (/avsec/scan) is gated server-side by lib/icms/ops-group.ts, which
 *  Phase 7 does not modify -- this list only proves Phase 7's OWN new nav
 *  never adds a scanner link for these roles. */
export const NO_SCANNER_ROLES = ["profiling_so", "profiling_aso", "investigation_sso", "investigation_so", "investigation_aso"];

/** Roles that get the shared GenericLinkHubDashboard, configured per role.
 *  Each entry composes only EXISTING routes/RPCs -- see
 *  components/dashboard/GenericLinkHubDashboard.tsx's own doc comment.
 *  Roles not listed here (and not handled by a dedicated component) fall
 *  back to the legacy dashboard -- see the Phase 7 closure report for the
 *  exact classification of every role. */
export const LINK_HUB_CONFIG: Record<string, LinkHubDashboardConfig> = {
  global_reporting_controller: {
    title: "VECTA Global Reporting Controller",
    subtitle: "Repository-wide secure report search, audit and export -- no Super Admin technical controls",
    links: [REPORT_SEARCH, EXPORT_ENTRY],
    showStaffing: false,
  },
  main_enforcement: {
    title: "Main Enforcement — Malaysia Enforcement Dashboard",
    subtitle: "Malaysia AOC · Enforcement department · Investigation/SAT/Profiling staffing and reports",
    links: [REPORT_SEARCH, ENFORCEMENT_SEARCH, SEC013],
    showHubBreakdown: true,
  },
  compliance: {
    title: "Compliance — Malaysia Overview",
    subtitle: "Malaysia AOC · Compliance department · read-only",
    links: [REPORT_SEARCH],
  },
  caterlink_management: {
    title: "CaterLink Management",
    subtitle: "CaterLink only -- no unrelated AVSEC report content",
    links: [ICMS_DASHBOARD, ICMS_TRANSACTIONS, ICMS_INCIDENTS, ICMS_WHITELIST, ICMS_ARCHIVE],
    showReportCounts: false,
    showStaffing: false,
  },
  investigation_sso: {
    title: "Investigation SSO — Malaysia-wide",
    subtitle: "Malaysia AOC · Enforcement · Investigation unit · MAA + AAX, no acknowledgement requirement",
    links: [REPORT_SEARCH, ENFORCEMENT_SEARCH],
  },
  investigation_so: {
    title: "Investigation SO — Malaysia-wide",
    subtitle: "Malaysia AOC · Enforcement · Investigation unit · MAA + AAX, no acknowledgement requirement",
    links: [REPORT_SEARCH, ENFORCEMENT_SEARCH],
  },
  investigation_aso: {
    title: "Investigation ASO — Malaysia-wide",
    subtitle: "Malaysia AOC · Enforcement · Investigation unit · MAA + AAX, no acknowledgement requirement",
    links: [REPORT_SEARCH, ENFORCEMENT_SEARCH],
  },
  sat_aso: {
    title: "SAT ASO — KUL",
    subtitle: "KUL hub · Enforcement · SAT unit · one combined 3-shift PDF per team per day",
    links: [DUTY, BAY_BOARD, REPORT_SEARCH],
  },
  profiling_so: {
    title: "Profiling SO",
    subtitle: "Malaysia AOC · Enforcement · Profiling unit · SEC013 · no checkpoint scanner",
    links: [SEC013, DUTY, REPORT_SEARCH],
  },
  profiling_aso: {
    title: "Profiling ASO",
    subtitle: "Malaysia AOC · Enforcement · Profiling unit · SEC013 · no checkpoint scanner",
    links: [SEC013, DUTY, REPORT_SEARCH],
  },
  hub_se: {
    title: "Hub SE",
    subtitle: "Assigned hub and its stations",
    links: [ROSTER, ABSENCES, OVERTIME, BAY_BOARD, REPORT_SEARCH],
    showHubBreakdown: true,
  },
  dse: {
    title: "KUL DSE",
    subtitle: "Assigned KUL team only",
    links: [ROSTER, ABSENCES, OVERTIME, BAY_BOARD, DUTY],
  },
  sso: {
    title: "SSO",
    subtitle: "Assigned station and team",
    links: [DUTY, BAY_BOARD, REPORT_SEARCH],
  },
  so: {
    title: "SO",
    subtitle: "Assigned station and team",
    links: [DUTY, BAY_BOARD, REPORT_SEARCH],
  },
  aso: {
    title: "ASO",
    subtitle: "Assigned station and team",
    links: [DUTY, BAY_BOARD],
  },
};
