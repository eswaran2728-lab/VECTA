import Link from "next/link";
import { AlertTriangle, Inbox, Lock, WifiOff } from "lucide-react";
import { cn } from "@/lib/avsec/utils";

/**
 * The five non-happy-path states, rendered the same way on every screen: empty, loading, error, offline and access-restricted.
 * They state what happened and what to do next in plain language and never reveal whether a hidden record exists.
 */
function StateShell({ icon, title, children, role, className }: { icon: React.ReactNode; title: string; children?: React.ReactNode; role?: "status" | "alert"; className?: string }) {
  return (
    <div role={role} className={cn("flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center", className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden>
        {icon}
      </span>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: { href: string; label: string } }) {
  return (
    <StateShell icon={<Inbox className="h-5 w-5" />} title={title} role="status">
      {children}
      {action ? (
        <Link href={action.href} className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground">
          {action.label}
        </Link>
      ) : null}
    </StateShell>
  );
}

export function ErrorState({ title = "Something went wrong", children, retryHref }: { title?: string; children?: React.ReactNode; retryHref?: string }) {
  return (
    <StateShell icon={<AlertTriangle className="h-5 w-5 text-destructive" />} title={title} role="alert">
      {children ?? "We couldn't load this. Try again shortly."}
      {retryHref ? (
        <Link href={retryHref} className="mt-3 inline-flex min-h-[44px] items-center rounded-lg border border-border px-4 text-sm font-semibold text-foreground">
          Try again
        </Link>
      ) : null}
    </StateShell>
  );
}

export function OfflineState({ children }: { children?: React.ReactNode }) {
  return (
    <StateShell icon={<WifiOff className="h-5 w-5" />} title="You're offline" role="status">
      {children ?? "Changes you make will be saved on this device and sent when you're back online."}
    </StateShell>
  );
}

export function AccessRestrictedState({ title = "This area isn't available for your account", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <StateShell icon={<Lock className="h-5 w-5" />} title={title} role="status">
      {children ?? "If you think you should have access, contact your administrator."}
    </StateShell>
  );
}

export function LoadingSkeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={cn("h-4 animate-pulse rounded bg-muted motion-reduce:animate-none", i === lines - 1 ? "w-2/3" : "w-full")} aria-hidden />
      ))}
    </div>
  );
}
