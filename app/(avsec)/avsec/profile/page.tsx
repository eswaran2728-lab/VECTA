import Link from "next/link";
import { requireProfile, DUTY_ROLES, ENFORCEMENT_SEARCH_ROLES } from "@/lib/avsec/auth";
import { signOut } from "@/lib/avsec/profile-actions";
import { ThemeOptions } from "@/components/avsec/layout/ThemeToggle";
import { ROLE_LABELS, REPORT_TYPES, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { initials } from "@/lib/avsec/utils";

export default async function ProfilePage() {
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);

  const isMonitor = profile.role !== "ASO";
  // Only team-scoped roles work a shift, so only they get a timesheet to look at.
  const worksAShift = (DUTY_ROLES as readonly string[]).includes(profile.role);

  const menu: { label: string; href: string; right?: string }[] = [
    { label: "My Reports", href: "/avsec/history" },
    ...((ORG_WIDE_ROLES as readonly string[]).includes(profile.role)
      ? [{ label: "Report Lookup", href: "/avsec/reports/lookup" }]
      : []),
    ...((ENFORCEMENT_SEARCH_ROLES as readonly string[]).includes(profile.role)
      ? [{ label: "Enforcement Search", href: "/avsec/enforcement/search" }]
      : []),
    ...(worksAShift ? [{ label: "My Timesheet", href: "/avsec/duty/timesheet" }] : []),
    { label: "Leave & Absence Records", href: "/avsec/duty/absences" },
    ...(isMonitor ? [{ label: "Dashboard", href: "/avsec/dashboard" }] : []),
    ...((ORG_WIDE_ROLES as readonly string[]).includes(profile.role)
      ? [
          { label: "Attendance Report", href: "/avsec/admin/attendance-report" },
          { label: "Leave & Absence Audit", href: "/avsec/admin/absences" },
          { label: "Overtime Records", href: "/avsec/duty/overtime" },
        ]
      : []),
    { label: "Bay Board", href: "/avsec/bay-board" },
    // Everyone can see where the geofence zones are; Management edits them in the admin section.
    ...((profile.role === "MANAGEMENT" || profile.role === "ADMIN") ? [] : [{ label: "Duty Zones", href: "/avsec/duty/zones" }]),
    ...((profile.role === "MANAGEMENT" || profile.role === "ADMIN")
      ? [
          { label: "User Management", href: "/avsec/admin/users" },
          { label: "Team Roster", href: "/avsec/admin/roster" },
          { label: "Duty Zones", href: "/avsec/admin/zones" },
          { label: "Google Sheets Sync", href: "/avsec/admin/sheet-sync" },
        ]
      : []),
    { label: "Change Password", href: "/avsec/auth/update-password" },
  ];

  return (
    <main className="min-h-screen bg-background pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="card p-5 flex items-center gap-4 border-l-4 border-l-primary">
          <div className="w-14 h-14 shrink-0 rounded-xl flex items-center justify-center font-mono text-lg font-bold bg-primary/20 text-primary border border-primary/30">
            {initials(profile.name)}
          </div>
          <div className="min-w-0">
            <div className="font-display font-bold text-lg text-foreground tracking-[0.03em] uppercase">
              {profile.name}
            </div>
            <div className="font-mono text-xs font-semibold text-primary mt-1">
              {ROLE_LABELS[profile.role]}
            </div>
            <div className="font-mono text-xs text-muted-foreground mt-0.5">
              {[profile.staff_no, profile.station, profile.team].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>

        <div className="card p-4 space-y-1">
          <div className="field-label">Profile status</div>
          <div className="font-mono text-xs font-bold text-success uppercase tracking-wider">
            ● {profile.status === "approved" ? "Approved" : profile.status}
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <div className="field-label">Appearance</div>
          <ThemeOptions />
          <p className="field-hint">
            Choose between Nocturne Light and Dark themes. Preference persists across sessions.
          </p>
        </div>

        <div className="card overflow-hidden !p-0 divide-y divide-border">
          {menu.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              className="flex items-center justify-between px-4 py-3.5 hover:bg-card/40 transition-colors group"
            >
              <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                {m.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground group-hover:text-primary transition-colors">
                →
              </span>
            </Link>
          ))}

          <form action={signOut}>
            <button
              type="submit"
              className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-destructive/10 transition-colors group cursor-pointer"
            >
              <span className="text-sm font-medium text-destructive">
                Sign out
              </span>
              <span className="font-mono text-xs text-destructive">
                →
              </span>
            </button>
          </form>
        </div>

        <div className="px-2 py-3 font-mono text-[10px] text-muted-foreground/60 leading-relaxed text-center uppercase tracking-widest">
          VECTA AVSEC OPS · {REPORT_TYPES.map((t) => t.replace("sec", "")).join(" / ")}
          <br />
          OFFLINE-FIRST PWA · IMMUTABLE SEC SUBMISSIONS
        </div>
      </div>
    </main>
  );
}
