/**
 * Responsive-shell navigation (mobile bottom bar, tablet rail, desktop sidebar), derived ONLY from the caller's canonical NavModel
 * (lib/dashboard/nav-capabilities.ts). It adds no destination of its own: Home, Reports and the Actions shortcuts are picked out
 * of links the role's model already contains, and the full menu is the model itself, so nothing a role can reach is hidden on a phone.
 *
 * Like the model, this is display logic, never authorization -- every destination re-authorizes server-side.
 */
import type { NavGroupModel, NavLink, NavModel } from "./nav-capabilities.ts";

/** Approved mobile bottom-navigation slots, in order. Alerts and More open sheets; Home, Reports are links. */
export const SHELL_SLOTS = ["home", "reports", "actions", "alerts", "more"] as const;
export type ShellSlot = (typeof SHELL_SLOTS)[number];

export interface ShellNav {
  home: NavLink | null;
  reports: NavLink | null;
  /** Operational shortcuts (duty, scanner, bay board, attendance ...) taken from the model's own operational groups. */
  actions: NavGroupModel[];
  /** The complete model: the rail, the sidebar and the More sheet all render this same list. */
  menu: NavGroupModel[];
}

/** Report destinations in priority order. Only a link the model already contains can be chosen. */
const REPORT_HREFS = [
  "/avsec/reports/lookup",
  "/avsec/entity-reports",
  "/avsec/reports/requests",
  "/avsec/reports/request-access",
  "/avsec/sat/reports",
  "/avsec/reports/sec013",
];

const ACTION_GROUP_TITLES = new Set(["OPERATIONS", "ATTENDANCE", "ATTENDANCE & APPROVALS", "ATTENDANCE & ROSTER", "HUB"]);

const path = (href: string) => href.split("#")[0].split("?")[0];

export function deriveShellNav(model: NavModel): ShellNav {
  const items = model.groups.flatMap((g) => g.items);

  const home = items.find((i) => i.icon === "dashboard") ?? null;

  let reports: NavLink | null = null;
  for (const href of REPORT_HREFS) {
    const hit = items.find((i) => path(i.href) === href);
    if (hit) {
      reports = hit;
      break;
    }
  }
  // A station officer files reports from the report section of the home page and reviews them under History; the model has no
  // separate Reports link for that role, so point at that existing section (same page the officer already lands on).
  if (!reports && model.kind === "station_operator") {
    reports = { href: "/#reports", label: "Reports", icon: "file-text", match: ["/avsec/history", "/avsec/reports"] };
  }

  const taken = new Set<string>([home?.href, reports?.href].filter(Boolean).map((h) => path(h as string)));
  const actions: NavGroupModel[] = [];
  for (const g of model.groups) {
    if (!ACTION_GROUP_TITLES.has(g.title)) continue;
    const seen = new Set<string>();
    const kept = g.items.filter((i) => {
      const p = path(i.href);
      if (taken.has(p) || seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    if (kept.length > 0) actions.push({ title: g.title, items: kept });
  }

  return { home, reports, actions, menu: model.groups };
}
