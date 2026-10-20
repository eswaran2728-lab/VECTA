"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LogOut, PanelLeftClose, PanelLeftOpen, Shield, Sparkles } from "lucide-react";
import type { NavGroupModel } from "@/lib/dashboard/nav-capabilities";
import { NavGroupsList } from "@/components/layout/NavGroupsList";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { WoisChatModal } from "@/components/wois/WoisChatModal";
import { ThemeQuickToggle } from "@/components/theme/AppearanceControl";
import { NAV_STORAGE_KEY } from "@/lib/theme/theme";

/**
 * Tablet / desktop navigation (>=768px). 72px icon rail on tablet; 256px sidebar on laptop and desktop that the user can collapse to
 * the same rail (kept in this browser only). Renders the SAME model as the mobile More sheet. Geometry is pure CSS (.vecta-rail,
 * .vecta-rail-label in app/globals.css), so there is no layout jump between server and client render.
 */
export function DesktopNavigationRail({
  userId,
  name,
  roleLabel,
  station,
  team,
  role,
  groups,
  signOutAction,
}: {
  userId: string;
  name: string;
  roleLabel: string | null;
  station?: string | null;
  team?: string | null;
  role: string | null;
  groups: NavGroupModel[];
  signOutAction?: () => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [woisOpen, setWoisOpen] = useState(false);

  useEffect(() => {
    setCollapsed(document.documentElement.getAttribute("data-nav") === "collapsed");
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.setAttribute("data-nav", "collapsed");
    else document.documentElement.removeAttribute("data-nav");
    try {
      if (next) localStorage.setItem(NAV_STORAGE_KEY, "collapsed");
      else localStorage.removeItem(NAV_STORAGE_KEY);
    } catch {
      // non-fatal
    }
  };

  return (
    <>
      <aside
        aria-label="Primary navigation"
        className="vecta-rail fixed bottom-0 left-0 top-0 z-40 hidden select-none flex-col overflow-hidden border-r border-shell-border bg-shell text-shell-foreground md:flex"
      >
        <div className="flex min-h-[64px] items-center gap-2 border-b border-shell-border px-4">
          <Link href="/" className="flex min-h-[44px] items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-shell-active" aria-label="VECTA home">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-shell-active">
              <Shield className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="vecta-rail-label text-base font-extrabold tracking-wide">VECTA</span>
          </Link>
        </div>

        <div className="border-b border-shell-border px-4 py-3">
          <p className="vecta-rail-label truncate text-sm font-semibold">{name || "User"}</p>
          <p className="vecta-rail-label truncate text-xs text-shell-muted">
            {[station, team ? `Team ${team}` : null, roleLabel].filter(Boolean).join(" · ")}
          </p>
        </div>

        <nav aria-label="Sections" className="flex-1 space-y-5 overflow-y-auto px-2 py-4">
          <NavGroupsList groups={groups} tone="shell" />
        </nav>

        <div className="space-y-2 border-t border-shell-border px-2 py-3">
          <button
            type="button"
            onClick={() => setWoisOpen(true)}
            title="Open W.O.I.S assistant"
            className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 text-sm font-semibold text-shell-foreground outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-shell-active"
          >
            <Sparkles className="h-[18px] w-[18px] shrink-0 text-shell-active" aria-hidden />
            <span className="vecta-rail-label">W.O.I.S Assistant</span>
          </button>
          <div className="flex flex-wrap items-center justify-center gap-1 lg:justify-between">
            <NotificationsBell userId={userId} tone="shell" />
            <ThemeQuickToggle tone="shell" />
            <button
              type="button"
              onClick={toggle}
              aria-pressed={collapsed}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
              className="hidden h-11 w-11 items-center justify-center rounded-lg text-shell-muted outline-none hover:bg-white/5 hover:text-shell-foreground focus-visible:ring-2 focus-visible:ring-shell-active lg:inline-flex"
            >
              {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />}
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {signOutAction ? (
              <form action={signOutAction}>
                <button type="submit" title="Sign out" className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 text-sm text-shell-muted outline-none hover:bg-white/5 hover:text-shell-foreground focus-visible:ring-2 focus-visible:ring-shell-active">
                  <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden />
                  <span className="vecta-rail-label">Sign out</span>
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </aside>

      <WoisChatModal isOpen={woisOpen} onClose={() => setWoisOpen(false)} userContext={{ role: role ?? undefined, station: station ?? undefined, team: team ?? undefined }} />
    </>
  );
}
