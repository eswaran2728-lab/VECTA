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

/**
 * Team-scoped bottom navigation, shared across the 5 pages that make up the
 * unified operational surface: the dashboard ("/"), Scan, Bay Board,
 * Transaction History, and Profile. Which tabs appear depends on the
 * viewer's ops_group (team) and whether their role is org-wide.
 */
export function TeamBottomNav({
  opsGroup,
  orgWide,
}: {
  opsGroup: OpsGroup | null;
  orgWide: boolean;
}) {
  const pathname = usePathname();

  let tabs: NavTab[];
  if (orgWide) {
    // Org-wide (admin/management/enforcement): no team-specific 3rd tab —
    // team filtering happens inside the Dashboard itself via the existing
    // ops-query-param tab switcher.
    tabs = [DASHBOARD, SCAN, REPORTS, PROFILE];
  } else if (opsGroup === "ifc_avsec") {
    tabs = [DASHBOARD, SCAN, TRANSACTION_HISTORY, PROFILE];
  } else if (opsGroup === "operation_avsec") {
    tabs = [DASHBOARD, SCAN, BAY_BOARD, PROFILE];
  } else if (opsGroup === "hub_avsec") {
    // Confirmed by the project owner: Hub AVSEC keeps Bay Board as its 3rd
    // tab, same as Operation AVSEC.
    tabs = [DASHBOARD, SCAN, BAY_BOARD, PROFILE];
  } else {
    // No ops_group and not org-wide (shouldn't normally happen for anyone
    // reaching these 5 pages) — fall back to the 3 tabs common to everyone.
    tabs = [DASHBOARD, SCAN, PROFILE];
  }

  const isActive = (tab: NavTab) => {
    const [tabPath] = tab.href.split("?");
    if (pathname === tabPath) return true;
    return (tab.match ?? []).some((m) => pathname.startsWith(m.split("?")[0]));
  };

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card"
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
