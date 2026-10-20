import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/avsec/utils";
import { StatusBadge, ScopeBadge, type StatusTone } from "@/components/ds/status";

/** Page title block: one h1 per page, optional eyebrow/description/actions. Actions sit at the top on mobile (important actions first). */
export function PageHeader({ title, eyebrow, description, actions }: { title: string; eyebrow?: string; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="text-xl font-bold leading-tight text-foreground sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Role + scope strip: the caller's role label and the scope badges (station, team, entity) all come from server-derived props. */
export function RoleScopeHeader({ roleLabel, scopes }: { roleLabel: string | null; scopes: Array<{ label: string; value: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Your role and scope">
      {roleLabel ? <StatusBadge tone="info">{roleLabel}</StatusBadge> : null}
      {scopes.map((s) => (
        <ScopeBadge key={`${s.label}:${s.value}`} label={s.label} value={s.value} />
      ))}
    </div>
  );
}

const CARD = "rounded-xl border border-border bg-card p-4 text-card-foreground shadow-[var(--shadow-card)]";

export function OperationalSummaryCard({ label, value, hint, tone, href }: { label: string; value: React.ReactNode; hint?: string; tone?: StatusTone; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      {tone ? <StatusBadge tone={tone} className="mt-2">{tone === "danger" ? "Needs attention" : tone === "warning" ? "Pending" : tone === "success" ? "On track" : "Active"}</StatusBadge> : null}
    </>
  );
  return href ? (
    <Link href={href} className={cn(CARD, "block min-h-[44px] transition-colors hover:border-primary")}>
      {body}
    </Link>
  ) : (
    <div className={CARD}>{body}</div>
  );
}

export function ActionCard({ title, description, href, icon, badge }: { title: string; description?: string; href: string; icon?: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <Link href={href} className={cn(CARD, "flex min-h-[56px] items-center gap-3 transition-colors hover:border-primary")}>
      {icon ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
      </span>
      {badge}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

export function ReportCard({ title, meta, status, tone = "neutral", href }: { title: string; meta?: string; status: string; tone?: StatusTone; href?: string }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {meta ? <span className="block truncate font-mono text-xs text-muted-foreground">{meta}</span> : null}
      </span>
      <StatusBadge tone={tone}>{status}</StatusBadge>
    </>
  );
  return href ? (
    <Link href={href} className={cn(CARD, "flex min-h-[56px] items-center gap-3 transition-colors hover:border-primary")}>
      {inner}
    </Link>
  ) : (
    <div className={cn(CARD, "flex min-h-[56px] items-center gap-3")}>{inner}</div>
  );
}

export function AssignmentStatusCard({ title, status, tone, detail }: { title: string; status: string; tone: StatusTone; detail?: string }) {
  return (
    <section className={CARD} aria-label={title}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <StatusBadge tone={tone}>{status}</StatusBadge>
      </div>
      {detail ? <p className="mt-2 text-sm text-muted-foreground">{detail}</p> : null}
    </section>
  );
}

export function AnnouncementCard({ title, body, meta, tone = "info" }: { title: string; body?: string; meta?: string; tone?: StatusTone }) {
  return (
    <article className={cn(CARD, "space-y-1")}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <StatusBadge tone={tone}>Announcement</StatusBadge>
      </div>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      {meta ? <p className="font-mono text-xs text-muted-foreground">{meta}</p> : null}
    </article>
  );
}

export function NotificationCard({ title, body, time, unread, href }: { title: string; body?: string; time: string; unread: boolean; href?: string }) {
  const inner = (
    <>
      <span className="flex items-center gap-2">
        {unread ? <StatusBadge tone="info">New</StatusBadge> : null}
        <span className="truncate text-sm font-semibold text-foreground">{title}</span>
      </span>
      {body ? <span className="block text-xs text-muted-foreground">{body}</span> : null}
      <span className="block font-mono text-[11px] text-muted-foreground">{time}</span>
    </>
  );
  return href ? (
    <Link href={href} className={cn(CARD, "block min-h-[44px] space-y-1 transition-colors hover:border-primary")}>
      {inner}
    </Link>
  ) : (
    <div className={cn(CARD, "space-y-1")}>{inner}</div>
  );
}
