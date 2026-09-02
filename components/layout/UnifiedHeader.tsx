import Link from "next/link";

/**
 * The one header used across every route — app/page.tsx's original inline
 * header, extracted so app/(avsec)/avsec/layout.tsx and
 * app/(icms)/icms/layout.tsx can render the exact same chrome instead of
 * each keeping their own competing header. `extra` is a slot for anything
 * route-specific that still needs to live in the header (AVSEC's ThemeToggle
 * uses a different data-theme mechanism than ICMS's class-based one — see
 * their own components — and only ICMS has LanguageToggle/NotificationsBell
 * at all, so those are passed in by each layout rather than hardcoded here).
 */
export function UnifiedHeader({
  name,
  roleLabel,
  signOutAction,
  extra,
}: {
  name: string;
  roleLabel: string | null;
  signOutAction: () => Promise<void>;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-[18px]">
      <Link href="/" className="flex shrink-0 items-center gap-2.5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2 L21 6 V12 C21 17 17 21 12 22 C7 21 3 17 3 12 V6 Z"
            stroke="var(--cyan)"
            strokeWidth="1.6"
          />
        </svg>
        <span className="font-display text-[17px] font-extrabold tracking-[0.06em]">VECTA</span>
      </Link>
      <div className="flex min-w-0 items-center gap-3">
        {extra}
        <span className="hidden truncate font-mono text-sm sm:inline">Signed in as {name}</span>
        {roleLabel ? <span className="vecta-chip shrink-0">{roleLabel}</span> : null}
        <form action={signOutAction}>
          <button
            type="submit"
            className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-brand"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
