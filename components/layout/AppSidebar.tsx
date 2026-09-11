"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { WoisChatModal } from "@/components/wois/WoisChatModal";
import {
  LayoutDashboard,
  Shield,
  QrCode,
  Plane,
  Clock,
  CalendarCheck,
  CalendarDays,
  Coffee,
  FileText,
  Search,
  MessageSquare,
  Megaphone,
  Users,
  MapPin,
  Sparkles,
  Truck,
  PackageCheck,
  Activity,
  LogOut,
  User,
} from "lucide-react";
import type { OpsGroup } from "@/lib/icms/database.types";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  match?: string[];
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export function AppSidebar({
  name,
  role,
  roleLabel,
  opsGroup,
  station,
  team,
  signOutAction,
}: {
  name: string;
  role: string | null;
  roleLabel: string | null;
  opsGroup: OpsGroup | null;
  station?: string | null;
  team?: string | null;
  signOutAction?: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [woisOpen, setWoisOpen] = useState(false);

  const normalizedRole = (role ?? "").toLowerCase();
  const isOrgWide = ["admin", "management", "enforcement", "super_admin"].includes(normalizedRole);
  const isDse = normalizedRole === "dse";
  const isDriver = ["warehouse_pic", "vendor"].includes(normalizedRole);
  const isVendor = normalizedRole === "vendor";

  // Build navigation groups based on role
  const groups: NavGroup[] = [];

  if (isVendor) {
    groups.push({
      title: "CATERING DISPATCH",
      items: [
        { href: "/icms/dashboard", label: "Overview", icon: LayoutDashboard },
        { href: "/icms/vendor-transactions/new", label: "+ New Delivery", icon: PackageCheck },
        { href: "/icms/vendor-transactions", label: "My Deliveries", icon: Truck },
      ],
    });
  } else if (isDriver) {
    groups.push({
      title: "CATERING LOGISTICS",
      items: [
        { href: "/icms/dashboard", label: "Driver Home", icon: LayoutDashboard },
        { href: "/icms/transactions/new", label: "+ New Dispatch", icon: PackageCheck },
        { href: "/icms/transactions", label: "Dispatch History", icon: Truck },
      ],
    });
  } else {
    // Standard AVSEC / VECTA Navigation
    const operationsItems: NavItem[] = [
      {
        href: isOrgWide ? "/avsec/dashboard" : "/",
        label: "Operations Dashboard",
        icon: LayoutDashboard,
      },
    ];

    if (!isOrgWide) {
      operationsItems.push({
        href: "/avsec/duty",
        label: "Duty Terminal & Check-In",
        icon: Clock,
      });
    }

    if (!isOrgWide && (opsGroup === "operation_avsec" || opsGroup === "ifc_avsec" || opsGroup === "hub_avsec")) {
      operationsItems.push({
        href: "/avsec/scan",
        label: "Checkpoint Scanner",
        icon: QrCode,
      });
    }

    if (isOrgWide || opsGroup === "operation_avsec" || opsGroup === "hub_avsec") {
      operationsItems.push({
        href: "/avsec/bay-board",
        label: "Bay Board (SEC016)",
        icon: Plane,
      });
    }

    if (isOrgWide || opsGroup === "ifc_avsec") {
      operationsItems.push({
        href: "/icms/transactions",
        label: "ICMS Catering Stream",
        icon: Activity,
      });
    }

    groups.push({
      title: "OPERATIONS",
      items: operationsItems,
    });

    // ATTENDANCE, LEAVE & ROSTER
    const attendanceItems: NavItem[] = [];

    if (isOrgWide) {
      attendanceItems.push({
        href: "/avsec/admin/attendance-monitor",
        label: "Attendance & OT Monitor",
        icon: CalendarCheck,
        badge: "MANAGEMENT",
      });
      attendanceItems.push({
        href: "/avsec/admin/absences",
        label: "Leave & Absence Audit",
        icon: Coffee,
      });
      attendanceItems.push({
        href: "/avsec/duty/overtime",
        label: "Overtime Management",
        icon: Clock,
      });
      attendanceItems.push({
        href: "/avsec/admin/roster",
        label: "Roster Management",
        icon: CalendarDays,
      });
    } else if (isDse) {
      attendanceItems.push({
        href: "/avsec/duty/absences",
        label: "Leave Approval Queue",
        icon: Coffee,
      });
      attendanceItems.push({
        href: "/avsec/duty/overtime",
        label: "OT Approval Queue",
        icon: Clock,
      });
      attendanceItems.push({
        href: "/avsec/admin/roster",
        label: "Team Duty Roster",
        icon: CalendarDays,
      });
    } else {
      // ASO / SO
      attendanceItems.push({
        href: "/avsec/duty/absences",
        label: "Apply & View Leaves",
        icon: Coffee,
      });
      attendanceItems.push({
        href: "/avsec/duty/overtime",
        label: "My Overtime Claims",
        icon: Clock,
      });
      attendanceItems.push({
        href: "/avsec/duty/timesheet",
        label: "My Timesheet",
        icon: CalendarDays,
      });
    }

    groups.push({
      title: "ATTENDANCE & ROSTER",
      items: attendanceItems,
    });

    // REPORTS & AUDIT (for management, admin, dse)
    if (isOrgWide || isDse) {
      const reportsItems: NavItem[] = [
        {
          href: "/avsec/reports/lookup",
          label: "Report Search & Lookup",
          icon: Search,
        },
        {
          href: "/?section=reports#reports",
          label: "File Security Report",
          icon: FileText,
        },
      ];

      groups.push({
        title: "SECURITY REPORTS",
        items: reportsItems,
      });
    }

    // COMMUNICATION
    const commsItems: NavItem[] = [];
    if (isOrgWide) {
      commsItems.push({
        href: "/avsec/management/announcements",
        label: "Broadcast Announcements",
        icon: Megaphone,
      });
      commsItems.push({
        href: "/avsec/management/feedback",
        label: "Staff Feedback Inbox",
        icon: MessageSquare,
      });
    } else {
      commsItems.push({
        href: "/avsec/feedback",
        label: "Anonymous Feedback",
        icon: MessageSquare,
      });
    }

    groups.push({
      title: "COMMUNICATION",
      items: commsItems,
    });

    // ADMIN MANAGEMENT
    if (isOrgWide) {
      groups.push({
        title: "ADMINISTRATION",
        items: [
          { href: "/avsec/admin/users", label: "User Directory", icon: Users },
          { href: "/avsec/admin/zones", label: "Duty Geofence Zones", icon: MapPin },
        ],
      });
    }
  }

  const isTabActive = (item: NavItem) => {
    const [itemPath] = item.href.split("?");
    if (pathname === itemPath) return true;
    if (item.match && item.match.some((m) => pathname.startsWith(m.split("?")[0]))) {
      return true;
    }
    return false;
  };

  return (
    <>
      <aside
        className="hidden lg:flex flex-col fixed top-0 bottom-0 left-0 z-40 w-64 border-r border-border bg-card/95 backdrop-blur-md overflow-hidden select-none"
        aria-label="Desktop Primary Navigation"
      >
        {/* Brand Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/80">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 border border-primary/25 text-primary transition-transform group-hover:scale-105">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <span className="font-display text-base font-extrabold tracking-wider text-foreground">
                VECTA
              </span>
              <span className="block font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
                AVSEC & ICMS OPS
              </span>
            </div>
          </Link>

          <ThemeToggle />
        </div>

        {/* User Context Banner */}
        <div className="px-5 py-3 border-b border-border/70 bg-muted/30">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="block truncate text-xs font-bold text-foreground">
                {name || "User"}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                {station ? `${station} · ` : ""}
                {team ? `Team ${team}` : (roleLabel || role || "Staff")}
              </span>
            </div>
            {roleLabel && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-primary border border-primary/25 shrink-0">
                {roleLabel}
              </span>
            )}
          </div>
        </div>

        {/* Scrollable Navigation Groups */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5 scrollbar-thin">
          {groups.map((group) => (
            <div key={group.title} className="space-y-1">
              <h3 className="px-3 font-mono text-[10px] font-bold tracking-wider text-muted-foreground uppercase">
                {group.title}
              </h3>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isTabActive(item);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                        active
                          ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <item.icon className={`h-4 w-4 shrink-0 ${active ? "text-primary-foreground" : "text-muted-foreground"}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                      {item.badge && (
                        <span
                          className={`rounded px-1.5 py-0.2 font-mono text-[9px] font-bold ${
                            active
                              ? "bg-primary-foreground/20 text-primary-foreground"
                              : "bg-primary/10 text-primary"
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* W.O.I.S AI Smartbook Quick Launcher */}
        <div className="p-3 border-t border-border/80 bg-card/60 space-y-2">
          <button
            type="button"
            onClick={() => setWoisOpen(true)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-gradient-to-r from-primary/15 via-primary/10 to-primary/5 border border-primary/30 text-xs font-bold text-primary hover:from-primary/25 hover:to-primary/10 transition-all cursor-pointer shadow-xs group"
            title="Open Work Order Intelligence Smartbook"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary animate-pulse" />
              <span className="font-display tracking-wide">W.O.I.S AI</span>
            </div>
            <span className="font-mono text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded group-hover:bg-primary/30">
              Ask AI →
            </span>
          </button>

          {/* User Profile & Sign Out Footer */}
          <div className="flex items-center justify-between gap-2 pt-1 px-1">
            <Link
              href="/avsec/profile"
              className="flex items-center gap-1.5 text-[11.5px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              <User className="h-3.5 w-3.5" />
              <span>Profile</span>
            </Link>

            {signOutAction && (
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-brand transition-colors cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign out</span>
                </button>
              </form>
            )}
          </div>
        </div>
      </aside>

      {/* W.O.I.S Chat Modal triggerable from Sidebar */}
      <WoisChatModal
        isOpen={woisOpen}
        onClose={() => setWoisOpen(false)}
        userContext={{
          role: role ?? undefined,
          ops_group: opsGroup ?? undefined,
          station: station ?? undefined,
          team: team ?? undefined,
        }}
      />
    </>
  );
}
