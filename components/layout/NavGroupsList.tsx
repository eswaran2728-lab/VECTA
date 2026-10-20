"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Shield, QrCode, Plane, Clock, CalendarCheck, CalendarDays, Coffee, FileText, Search, MessageSquare, Megaphone,
  Users, MapPin, Sparkles, Truck, PackageCheck, Activity, User, Building2, Inbox,
} from "lucide-react";
import type { NavGroupModel, NavIcon, NavLink } from "@/lib/dashboard/nav-capabilities";

export const NAV_ICONS: Record<NavIcon, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  shield: Shield,
  scan: QrCode,
  plane: Plane,
  clock: Clock,
  "calendar-check": CalendarCheck,
  "calendar-days": CalendarDays,
  coffee: Coffee,
  "file-text": FileText,
  search: Search,
  message: MessageSquare,
  megaphone: Megaphone,
  users: Users,
  "map-pin": MapPin,
  sparkles: Sparkles,
  truck: Truck,
  package: PackageCheck,
  activity: Activity,
  user: User,
  building: Building2,
  inbox: Inbox,
};

export function isNavLinkActive(pathname: string, item: NavLink): boolean {
  const [itemPath] = item.href.split("?");
  if (pathname === itemPath) return true;
  return Boolean(item.match?.some((m) => pathname.startsWith(m.split("?")[0])));
}

/** Shared renderer for the desktop sidebar and the tablet/mobile drawer: one model, one markup, no drift. */
/**
 * tone "surface" = light/dark card surfaces (drawer, sheets); tone "shell" = the midnight-navy rail / sidebar.
 * In the rail, labels collapse to screen-reader-only text (class vecta-rail-label) so the collapsed rail stays fully accessible.
 */
export function NavGroupsList({ groups, onNavigate, tone = "surface" }: { groups: NavGroupModel[]; onNavigate?: () => void; tone?: "surface" | "shell" }) {
  const shell = tone === "shell";
  const pathname = usePathname();
  return (
    <>
      {groups.map((group) => (
        <div key={group.title} className="space-y-1">
          <h3 className={`px-3 font-mono text-[10px] font-bold uppercase tracking-wider ${shell ? "vecta-rail-label text-shell-muted" : "text-muted-foreground"}`}>{group.title}</h3>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isNavLinkActive(pathname ?? "", item);
              const Icon = NAV_ICONS[item.icon];
              return (
                <li key={`${group.title}:${item.href}`}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                    className={`flex min-h-[44px] items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      shell
                        ? `focus-visible:ring-offset-shell ${active ? "bg-white/10 font-semibold text-shell-foreground" : "text-shell-muted hover:bg-white/5 hover:text-shell-foreground"}`
                        : `focus-visible:ring-offset-background ${active ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${shell ? (active ? "text-shell-active" : "text-shell-muted") : active ? "text-primary-foreground" : "text-muted-foreground"}`} />
                      <span className={`truncate ${shell ? "vecta-rail-label" : ""}`}>{item.label}</span>
                    </span>
                    {item.badge ? (
                      <span className={`rounded px-1.5 font-mono text-[9px] font-bold ${active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-primary/10 text-primary"}`}>
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
