import Link from "next/link";
import Image from "next/image";
import { signOut } from "@/lib/profile-actions";
import { landingPathForRole } from "@/lib/auth";
import { APP_NAME } from "@/lib/branding";
import type { Profile } from "@/lib/types";

export function AppHeader({
  profile,
  title,
  backHref,
}: {
  profile: Profile;
  title?: string;
  backHref?: string;
}) {
  const isMonitor = profile.role !== "ASO";
  const isEnforcement = profile.role === "ENFORCEMENT" || profile.role === "ADMIN";
  const isAdmin = profile.role === "ADMIN";
  const canSubmitDaily = profile.role === "SO" || profile.role === "DSE" || profile.role === "ENFORCEMENT";

  return (
    <header className="sticky top-0 z-10 bg-white/90 dark:bg-slate-950/90 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {backHref && (
            <Link
              href={backHref}
              className="text-slate-500 hover:text-slate-800 dark:hover:text-white shrink-0"
              aria-label="Back"
            >
              ←
            </Link>
          )}
          <Image
            src="/icons/icon-192.png"
            alt="AVSEC AirAsia"
            width={32}
            height={32}
            className="rounded-lg shrink-0"
          />
          <div className="min-w-0">
            <Link
              href={landingPathForRole(profile.role)}
              className="font-bold text-brand-700 dark:text-brand-400 block truncate"
            >
              {title ?? APP_NAME}
            </Link>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {profile.name} · {profile.station} · {profile.team}
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-3 shrink-0">
          {isMonitor && (
            <Link href="/dashboard" className="btn-quiet">
              Dashboard
            </Link>
          )}
          {canSubmitDaily && (
            <Link href="/reports/sec014" className="btn-quiet">
              Daily Report
            </Link>
          )}
          {isEnforcement && (
            <Link href="/search" className="btn-quiet">
              Search
            </Link>
          )}
          {isAdmin && (
            <Link href="/admin/users" className="btn-quiet">
              Users
            </Link>
          )}
          <form action={signOut}>
            <button type="submit" className="btn-quiet">
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
