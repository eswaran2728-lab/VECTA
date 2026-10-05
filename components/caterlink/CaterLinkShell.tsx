import { LogOut, Truck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CaterLinkNavLink } from "./CaterLinkNavLink";

export interface CaterLinkNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The CaterLink portal chrome for the three CaterLink-only identities (CaterLink Management, Driver, Third-Party
 * Vendor). It carries CaterLink branding and CaterLink navigation only: no VECTA dashboard, AVSEC workforce or
 * report links, no Super Admin link and no app switcher. Server-side gates (middleware, pages, actions, APIs,
 * RLS) enforce the boundary; this shell only avoids offering what is not allowed.
 */
export function CaterLinkShell({
  name,
  roleLabel,
  nav,
  signOutAction,
  languageToggle,
  children,
}: {
  name: string;
  roleLabel: string;
  nav: CaterLinkNavItem[];
  signOutAction: () => Promise<void>;
  languageToggle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased" data-portal="caterlink">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-card lg:flex">
        <div className="flex items-center gap-3 border-b px-5 py-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Truck className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight tracking-tight">CaterLink</p>
            <p className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">Catering movement control</p>
          </div>
        </div>
        <div className="border-b px-5 py-4">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
        </div>
        <nav aria-label="CaterLink navigation" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {nav.map((item) => (
            <CaterLinkNavLink key={item.href} href={item.href} label={item.label} variant="sidebar" icon={<item.icon className="h-4 w-4 shrink-0" aria-hidden />} />
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
          {languageToggle}
          <form action={signOutAction}>
            <button type="submit" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted">
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* mobile header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-card/95 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Truck className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold leading-tight">CaterLink</p>
            <p className="truncate text-[11px] text-muted-foreground">{roleLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {languageToggle}
          <form action={signOutAction}>
            <button type="submit" aria-label="Sign out" className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground hover:bg-muted">
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="flex min-h-screen flex-col pb-24 lg:pb-8 lg:pl-64">
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      </div>

      {/* mobile bottom navigation */}
      <nav aria-label="CaterLink navigation" className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-card lg:hidden">
        {nav.slice(0, 5).map((item) => (
          <CaterLinkNavLink key={item.href} href={item.href} label={item.label} variant="bottom" icon={<item.icon className="h-5 w-5" aria-hidden />} />
        ))}
      </nav>
    </div>
  );
}
