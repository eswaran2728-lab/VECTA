"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { OpsGroup } from "@/lib/icms/database.types";

interface NavTab {
  href: string;
  label: string;
  /** Extra path prefixes that should also light this tab up. */
  match?: string[];
}

const DASHBOARD: NavTab = { href: "/", label: "Dashboard" };
const SCAN: NavTab = { href: "/avsec/scan", label: "Scan" };
const TRANSACTION_HISTORY: NavTab = {
  href: "/icms/transactions",
  label: "Transaction History",
  match: ["/icms/transactions"],
};
const BAY_BOARD: NavTab = { href: "/avsec/bay-board", label: "Bay Board" };
const PROFILE: NavTab = { href: "/avsec/profile", label: "Profile" };
// Reports has no route of its own — org-wide roles get it from within the
// unified dashboard's Reports section (see app/page.tsx).
const REPORTS: NavTab = { href: "/?section=reports#reports", label: "Reports", match: ["/?section=reports"] };
// Management/Enforcement/Admin don't work a checkpoint themselves, so Scan
// is meaningless for them — Report Search (existing /avsec/reports/lookup
// page, already restricted to exactly these roles) replaces it instead.
const REPORT_SEARCH: NavTab = { href: "/avsec/reports/lookup", label: "Report Search" };

const NEW_TRANSACTION: NavTab = {
  href: "/caterlink/transactions/new",
  label: "+ New",
  match: ["/caterlink/transactions/new", "/icms/transactions/new"],
};
const NEW_DELIVERY: NavTab = {
  href: "/caterlink/vendor-transactions/new",
  label: "+ New",
  match: ["/caterlink/vendor-transactions/new", "/icms/vendor-transactions/new"],
};
const MY_DISPATCHES: NavTab = {
  href: "/caterlink/transactions",
  label: "Dispatches",
  match: ["/caterlink/transactions", "/icms/transactions"],
};
const MY_DELIVERIES: NavTab = {
  href: "/caterlink/vendor-transactions",
  label: "Deliveries",
  match: ["/caterlink/vendor-transactions", "/icms/vendor-transactions"],
};
const DRIVER_HOME: NavTab = {
  href: "/caterlink/dashboard",
  label: "Home",
  match: ["/caterlink/dashboard", "/caterlink", "/icms/dashboard"],
};

/**
 * Team-scoped bottom navigation, shared across the operational surfaces.
 * For drivers (warehouse_pic, vendor), provides dedicated, minimal dispatch actions.
 */
export function TeamBottomNav({
  opsGroup,
  orgWide,
  role,
}: {
  opsGroup: OpsGroup | null;
  orgWide: boolean;
  role?: string | null;
}) {
  const pathname = usePathname();

  const isDriver =
    role === "warehouse_pic" ||
    role === "vendor" ||
    (pathname.startsWith("/icms") && !opsGroup && !orgWide);

  let tabs: NavTab[];
  if (role === "vendor") {
    tabs = [NEW_DELIVERY, MY_DELIVERIES, DRIVER_HOME];
  } else if (isDriver) {
    tabs = [NEW_TRANSACTION, MY_DISPATCHES, DRIVER_HOME];
  } else if (orgWide) {
    tabs = [DASHBOARD, REPORT_SEARCH, REPORTS, PROFILE];
  } else if (role === "so" && (opsGroup === "operation_avsec" || opsGroup === "hub_avsec")) {
    // SO - Operation: Bay Board access, NO Scan/CaterLink clearance
    tabs = [DASHBOARD, BAY_BOARD, PROFILE];
  } else if (role === "so" && opsGroup === "ifc_avsec") {
    // SO - IFC: Scan / Transaction access at Post 2, Transaction History
    tabs = [DASHBOARD, SCAN, TRANSACTION_HISTORY, PROFILE];
  } else if (role === "dse" && (opsGroup === "operation_avsec" || opsGroup === "hub_avsec")) {
    // DSE - Operation: Bay Board access, NO Scan
    tabs = [DASHBOARD, BAY_BOARD, PROFILE];
  } else if (role === "dse" && opsGroup === "ifc_avsec") {
    // DSE - IFC: Team KPIs, Transaction History, NO Bay Board
    tabs = [DASHBOARD, TRANSACTION_HISTORY, PROFILE];
  } else if (opsGroup === "ifc_avsec") {
    // ASO - IFC: Scan at Post 2, Transaction History, NO Bay Board
    tabs = [DASHBOARD, SCAN, TRANSACTION_HISTORY, PROFILE];
  } else if (opsGroup === "operation_avsec" || opsGroup === "hub_avsec") {
    // ASO - Operation: Scan at Post 6 / RedQ, Bay Board
    tabs = [DASHBOARD, SCAN, BAY_BOARD, PROFILE];
  } else {
    tabs = [DASHBOARD, SCAN, PROFILE];
  }

  const isActive = (tab: NavTab) => {
    const [tabPath] = tab.href.split("?");
    if (pathname === tabPath) return true;
    return (tab.match ?? []).some((m) => pathname.startsWith(m.split("?")[0]));
  };

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Primary"
    >
      <div className={`mx-auto grid max-w-3xl`} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const active = isActive(tab);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[52px] flex-col items-center justify-center gap-1 px-1 py-2 text-center ${
                active ? "bg-secondary text-primary" : "text-muted-foreground"
              }`}
            >
              <span
                aria-hidden
                className={`h-[5px] w-[5px] rounded-full ${active ? "bg-primary" : "bg-transparent"}`}
              />
              <span className="font-mono text-[10.5px] font-semibold leading-tight tracking-[0.02em]">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
