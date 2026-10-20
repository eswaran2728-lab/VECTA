import Link from "next/link";
import { requireProfile, DUTY_ROLES, ENFORCEMENT_SEARCH_ROLES } from "@/lib/avsec/auth";
import { signOut } from "@/lib/avsec/profile-actions";
import { ThemeOptions } from "@/components/avsec/layout/ThemeToggle";
import { AssignmentStatusCard } from "@/components/ds/cards";
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
          { label: "Attendance & OT Monitor", href: "/avsec/admin/attendance-monitor" },
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
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 font-mono text-lg font-bold text-foreground" aria-hidden>
            {initials(profile.name)}
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-lg font-bold text-foreground">{profile.name}</h1>
            <div className="mt-1 text-sm font-semibold text-primary">{ROLE_LABELS[profile.role]}</div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{[profile.staff_no, profile.station, profile.team].filter(Boolean).join(" · ")}</div>
          </div>
        </div>

        <AssignmentStatusCard title="Profile status" status={profile.status === "approved" ? "Approved" : profile.status} tone={profile.status === "approved" ? "success" : "warning"} />

        <section aria-label="Appearance" className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <ThemeOptions />
          <p className="mt-2 text-xs text-muted-foreground">Saved on this device only. &ldquo;Use Device Setting&rdquo; follows your phone or computer.</p>
        </section>

        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
          {menu.map((m) => (
            <Link key={m.href} href={m.href} className="group flex min-h-[48px] items-center justify-between px-4 py-3 transition-colors hover:bg-muted">
              <span className="text-sm font-medium text-foreground">{m.label}</span>
              <span className="text-muted-foreground" aria-hidden>
                →
              </span>
            </Link>
          ))}

          <form action={signOut}>
            <button type="submit" className="group flex min-h-[48px] w-full cursor-pointer items-center justify-between px-4 py-3 text-left transition-colors hover:bg-destructive/10">
              <span className="text-sm font-medium text-destructive">Sign out</span>
              <span className="text-destructive" aria-hidden>
                →
              </span>
            </button>
          </form>
        </div>

        <p className="px-2 py-3 text-center text-xs leading-relaxed text-muted-foreground">
          VECTA AVSEC OPS · {REPORT_TYPES.map((t) => t.replace("sec", "")).join(" / ")}
          <br />
          Offline-first PWA · Immutable SEC submissions
        </p>
      </div>
    </main>
  );
}
