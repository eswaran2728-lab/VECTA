import Link from "next/link";
import { signOut } from "@/lib/profile-actions";
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
  const isSupervisor = profile.role !== "OFFICER";

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
          <div className="min-w-0">
            <Link href="/home" className="font-bold text-brand-700 dark:text-brand-300 block truncate">
              {title ?? APP_NAME}
            </Link>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {profile.name} · {profile.station} · {profile.team}
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-3 shrink-0">
          {isSupervisor && (
            <Link href="/dashboard" className="btn-quiet">
              Dashboard
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
