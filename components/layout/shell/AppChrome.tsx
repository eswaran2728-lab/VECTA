import Link from "next/link";
import { Shield } from "lucide-react";
import type { NavModel } from "@/lib/dashboard/nav-capabilities";
import { deriveShellNav } from "@/lib/dashboard/shell-nav";
import { DesktopNavigationRail } from "@/components/layout/shell/DesktopNavigationRail";
import { MobileBottomNavigation } from "@/components/layout/shell/MobileBottomNavigation";

/**
 * The single application chrome for every signed-in VECTA workspace: navy rail / sidebar (tablet and desktop), slim navy top bar and
 * bottom navigation (phones), and the content area. Navigation is derived from the caller's NavModel only; this component adds no
 * authorization and no destination. A future role workspace gets the whole shell, both themes and the responsive behaviour by
 * passing its model here.
 */
export function AppChrome({
  userId,
  name,
  roleLabel,
  model,
  station,
  team,
  signOutAction,
  children,
}: {
  userId: string;
  name: string;
  roleLabel: string | null;
  model: NavModel;
  station?: string | null;
  team?: string | null;
  signOutAction?: () => Promise<void>;
  children: React.ReactNode;
}) {
  const shell = deriveShellNav(model);
  return (
    <>
      <DesktopNavigationRail
        userId={userId}
        name={name}
        roleLabel={roleLabel}
        station={station}
        team={team}
        role={model.roleCode}
        groups={shell.menu}
        signOutAction={signOutAction}
      />
      <div className="vecta-shell-offset min-h-screen pb-24 md:pb-8">
        <header className="sticky top-0 z-20 flex min-h-[56px] items-center justify-between gap-3 border-b border-shell-border bg-shell px-4 text-shell-foreground md:hidden">
          <Link href={shell.home?.href ?? "/"} className="flex min-h-[44px] items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-shell-active" aria-label="VECTA home">
            <Shield className="h-5 w-5 text-shell-active" aria-hidden />
            <span className="text-base font-extrabold tracking-wide">VECTA</span>
          </Link>
          <span className="flex min-w-0 items-center gap-2 text-xs text-shell-muted">
            {station ? <span className="truncate">{station}</span> : null}
            {roleLabel ? <span className="shrink-0 rounded-full border border-shell-border px-2 py-0.5 font-semibold text-shell-foreground">{roleLabel}</span> : null}
          </span>
        </header>
        {children}
      </div>
      <MobileBottomNavigation shell={shell} userId={userId} signOutAction={signOutAction} />
    </>
  );
}
