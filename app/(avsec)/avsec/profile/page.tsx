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
    ...(isMonitor ? [{ label: "Dashboard", href: "/avsec/dashboard" }] : []),
    ...((ORG_WIDE_ROLES as readonly string[]).includes(profile.role)
      ? [
          { label: "Attendance Report", href: "/avsec/admin/attendance-report" },
          { label: "Overtime Records", href: "/avsec/duty/overtime" },
        ]
      : []),
    { label: "Bay Board", href: "/avsec/bay-board" },
    // Everyone can see where the geofence zones are; only Admin can edit them.
    ...(profile.role === "ADMIN" ? [] : [{ label: "Duty Zones", href: "/avsec/duty/zones" }]),
    ...(profile.role === "ADMIN"
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
    <main className="min-h-screen pb-32" style={{ background: "var(--page)" }}>

      <div className="max-w-3xl mx-auto animate-slide">
        <div
          className="flex items-center gap-3.5 px-4 py-5"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          <div
            className="w-14 h-14 shrink-0 flex items-center justify-center t-mono text-[18px] font-bold"
            style={{ background: "var(--gold-fill)", color: "var(--on-gold)" }}
          >
            {initials(profile.name)}
          </div>
          <div className="min-w-0">
            <div
              className="font-condensed font-semibold text-[19px] leading-none uppercase"
              style={{ letterSpacing: "0.1em", color: "var(--ink)" }}
            >
              {profile.name}
            </div>
            <div className="t-mono text-[10.5px] font-medium mt-1.5" style={{ color: "var(--gold)" }}>
              {ROLE_LABELS[profile.role]}
            </div>
            <div className="t-mono text-[10.5px] mt-1" style={{ color: "var(--soft)" }}>
              {[profile.staff_no, profile.station, profile.team].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>

        <div className="px-4 py-3.5" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="field-label">Profile status</div>
          <div className="font-semibold text-[13px]" style={{ color: "var(--green)" }}>
            {profile.status === "approved" ? "Approved" : profile.status}
          </div>
        </div>

        <div className="px-4 py-3.5" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="field-label">Appearance</div>
          <ThemeOptions />
          <p className="field-hint">
            System follows your device setting. Your choice is remembered on this device.
          </p>
        </div>

        {menu.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="flex items-center justify-between px-4 py-4 transition-colors"
            style={{ borderBottom: "1px solid var(--line2)" }}
          >
            <span className="text-[14px] font-medium" style={{ color: "var(--ink2)" }}>
              {m.label}
            </span>
            <span className="t-mono text-[11px]" style={{ color: "var(--faintest)" }}>
              ›
            </span>
          </Link>
        ))}

        <form action={signOut}>
          <button
            type="submit"
            className="w-full flex items-center justify-between px-4 py-4 text-left transition-colors"
            style={{ borderBottom: "1px solid var(--line2)" }}
          >
            <span className="text-[14px] font-medium" style={{ color: "var(--red)" }}>
              Sign out
            </span>
          </button>
        </form>

        <div
          className="px-4 py-5 t-mono text-[9.5px] leading-relaxed"
          style={{ letterSpacing: "0.08em", color: "var(--faintest)" }}
        >
          AVSEC REPORTS · {REPORT_TYPES.map((t) => t.replace("sec", "")).join(" / ")}
          <br />
          OFFLINE-FIRST PWA · IMMUTABLE SUBMISSIONS
        </div>
      </div>

    </main>
  );
}
