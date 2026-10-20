"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ClipboardList, FileText, Home, MoreHorizontal } from "lucide-react";
import type { NavLink } from "@/lib/dashboard/nav-capabilities";
import type { ShellNav } from "@/lib/dashboard/shell-nav";
import { NavGroupsList, isNavLinkActive } from "@/components/layout/NavGroupsList";
import { NotificationsList, useNotifications } from "@/components/layout/NotificationsBell";
import { BottomSheet } from "@/components/layout/shell/BottomSheet";
import { AppearanceControl } from "@/components/theme/AppearanceControl";

type Sheet = "actions" | "alerts" | "more" | null;

const TAB_BASE =
  "relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-center text-[11px] font-semibold leading-tight outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-shell-active";

function tabTone(active: boolean) {
  return active ? "text-shell-active" : "text-shell-muted hover:text-shell-foreground";
}

/**
 * Mobile bottom navigation (phones, <768px): Home, Reports, Actions, Alerts, More. Home and Reports are links; Actions, Alerts and More
 * open bottom sheets. Slots a role has no authorized destination for are simply omitted (never a dead link). Everything shown comes
 * from the role's NavModel through lib/dashboard/shell-nav.ts. Hidden from tablet width upward, where the rail takes over.
 */
export function MobileBottomNavigation({
  shell,
  userId,
  signOutAction,
}: {
  shell: ShellNav;
  userId: string;
  signOutAction?: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [sheet, setSheet] = useState<Sheet>(null);
  const notifications = useNotifications(userId);

  const close = useCallback(() => setSheet(null), []);
  useEffect(() => setSheet(null), [pathname]);

  const activeLink = (l: NavLink | null) => (l ? isNavLinkActive(pathname ?? "", l) : false);
  const hasActions = shell.actions.length > 0;
  const slots = 2 + (shell.home ? 1 : 0) + (shell.reports ? 1 : 0) + (hasActions ? 1 : 0); // alerts + more always present
  const homeActive = activeLink(shell.home);
  const reportsActive = activeLink(shell.reports) && !homeActive;

  const openAlerts = async () => {
    setSheet("alerts");
    await notifications.toggle();
  };

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-shell-border bg-shell text-shell-foreground md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <ul className="mx-auto grid max-w-xl" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
          {shell.home ? (
            <li>
              <Link href={shell.home.href} aria-current={homeActive ? "page" : undefined} className={`${TAB_BASE} ${tabTone(homeActive)}`}>
                <Home className="h-5 w-5" aria-hidden />
                <span>Home</span>
              </Link>
            </li>
          ) : null}
          {shell.reports ? (
            <li>
              <Link href={shell.reports.href} aria-current={reportsActive ? "page" : undefined} className={`${TAB_BASE} ${tabTone(reportsActive)}`}>
                <FileText className="h-5 w-5" aria-hidden />
                <span>Reports</span>
              </Link>
            </li>
          ) : null}
          {hasActions ? (
            <li>
              <button type="button" onClick={() => setSheet("actions")} aria-haspopup="dialog" aria-expanded={sheet === "actions"} className={`${TAB_BASE} w-full ${tabTone(sheet === "actions")}`}>
                <ClipboardList className="h-5 w-5" aria-hidden />
                <span>Actions</span>
              </button>
            </li>
          ) : null}
          <li>
            <button
              type="button"
              onClick={openAlerts}
              aria-haspopup="dialog"
              aria-expanded={sheet === "alerts"}
              aria-label={notifications.unread > 0 ? `Alerts, ${notifications.unread} unread` : "Alerts"}
              className={`${TAB_BASE} w-full ${tabTone(sheet === "alerts")}`}
            >
              <span className="relative">
                <Bell className="h-5 w-5" aria-hidden />
                {notifications.unread > 0 ? (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-foreground">{notifications.unread}</span>
                ) : null}
              </span>
              <span>Alerts</span>
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setSheet("more")} aria-haspopup="dialog" aria-expanded={sheet === "more"} className={`${TAB_BASE} w-full ${tabTone(sheet === "more")}`}>
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>

      <BottomSheet open={sheet === "actions"} title="Actions" onClose={close}>
        <nav aria-label="Actions" className="space-y-4">
          <NavGroupsList groups={shell.actions} onNavigate={close} />
        </nav>
      </BottomSheet>

      <BottomSheet open={sheet === "alerts"} title="Alerts" onClose={close}>
        <NotificationsList items={notifications.items} loading={notifications.loading} error={notifications.error} onNavigate={close} />
      </BottomSheet>

      <BottomSheet open={sheet === "more"} title="More" onClose={close}>
        <div className="space-y-5">
          <nav aria-label="All sections" className="space-y-4">
            <NavGroupsList groups={shell.menu} onNavigate={close} />
          </nav>
          <section aria-label="Appearance" className="border-t border-border pt-4">
            <AppearanceControl />
          </section>
          {signOutAction ? (
            <form action={signOutAction} className="border-t border-border pt-3">
              <button type="submit" className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-sm font-semibold text-foreground hover:bg-muted">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </BottomSheet>
    </>
  );
}
