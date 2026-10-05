"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { phase7DashboardNavEntry, scannerNavAllowedForRole } from "@/lib/dashboard/navigation";

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
  href: "/icms/transactions/new",
  label: "+ New",
  match: ["/caterlink/transactions/new", "/icms/transactions/new"],
};
const NEW_DELIVERY: NavTab = {
  href: "/icms/vendor-transactions/new",
  label: "+ New",
  match: ["/caterlink/vendor-transactions/new", "/icms/vendor-transactions/new"],
};
const MY_DISPATCHES: NavTab = {
  href: "/icms/transactions",
  label: "Dispatches",
  match: ["/caterlink/transactions", "/icms/transactions"],
};
const MY_DELIVERIES: NavTab = {
  href: "/icms/vendor-transactions",
  label: "Deliveries",
  match: ["/caterlink/vendor-transactions", "/icms/vendor-transactions"],
};
const DRIVER_HOME: NavTab = {
  href: "/icms/dashboard",
  label: "Home",
  match: ["/caterlink/dashboard", "/caterlink", "/icms/dashboard"],
};

/**
 * Team-scoped bottom navigation, shared across the operational surfaces.
 * For drivers (warehouse_pic, vendor), provides dedicated, minimal dispatch actions.
 */
export function TeamBottomNav({
  orgWide,
  role,
  canScan = false,
  hasPhase7Assignment = false,
}: {
  orgWide: boolean;
  role?: string | null;
  /** Canonical decision (station operator at a scan-capable station), computed server-side. Display only. */
  canScan?: boolean;
  /** Phase 7: whether this profile holds at least one active Phase 3 role
   *  assignment. Purely a display decision -- see
   *  lib/dashboard/navigation.ts's own doc comment. Drivers/vendors never
   *  get this tab (they have no AVSEC dashboard context to select). */
  hasPhase7Assignment?: boolean;
}) {
  const pathname = usePathname();

  const isDriver = role === "warehouse_pic" || role === "vendor";

  const phase7Entry = !isDriver ? phase7DashboardNavEntry(hasPhase7Assignment) : null;
  const phase7Tab: NavTab[] = phase7Entry ? [{ href: phase7Entry.href, label: phase7Entry.label }] : [];

  let tabs: NavTab[];
  if (role === "vendor") {
    tabs = [NEW_DELIVERY, MY_DELIVERIES, DRIVER_HOME];
  } else if (isDriver) {
    tabs = [NEW_TRANSACTION, MY_DISPATCHES, DRIVER_HOME];
  } else if (orgWide) {
    tabs = [DASHBOARD, REPORT_SEARCH, REPORTS, ...phase7Tab, PROFILE];
  } else if (role === "aso" || role === "so" || role === "dse") {
    // One operational structure: every station-scoped operator gets the Bay Board;
    // Scan and Transaction History appear only where the station holds the
    // approved CaterLink scan capability.
    tabs = canScan ? [DASHBOARD, SCAN, TRANSACTION_HISTORY, BAY_BOARD, ...phase7Tab, PROFILE] : [DASHBOARD, BAY_BOARD, ...phase7Tab, PROFILE];
  } else {
    tabs = [DASHBOARD, ...phase7Tab, PROFILE];
  }

  // Phase 9 / Profiling exclusion: roles without scanner navigation (e.g. profiling_so, profiling_aso)
  // must never see the SCAN tab in bottom navigation.
  if (!scannerNavAllowedForRole(role ?? null)) {
    tabs = tabs.filter((t) => t.href !== SCAN.href);
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
