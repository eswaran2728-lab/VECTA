import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/lib/profile-actions";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { ThemeOptions } from "@/components/layout/ThemeToggle";
import { ROLE_LABELS, REPORT_TYPES } from "@/lib/reference-data";
import { initials } from "@/lib/utils";

export default async function ProfilePage() {
  const profile = await requireProfile();

  const isMonitor = profile.role !== "ASO";

  const menu: { label: string; href: string; right?: string }[] = [
    { label: "My Reports", href: "/history" },
    { label: "My Timesheet", href: "/duty/timesheet" },
    ...(isMonitor ? [{ label: "Dashboard", href: "/dashboard" }] : []),
    { label: "Bay Board", href: "/bay-board" },
    ...(profile.role === "ADMIN"
      ? [
          { label: "User Management", href: "/admin/users" },
          { label: "Team Roster", href: "/admin/roster" },
        ]
      : []),
    { label: "Change Password", href: "/auth/update-password" },
  ];

  return (
    <main className="min-h-screen pb-32" style={{ background: "var(--page)" }}>
      <AppHeader profile={profile} title="Profile" backHref="/home" />

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

      <BottomNav profile={profile} />
    </main>
  );
}
