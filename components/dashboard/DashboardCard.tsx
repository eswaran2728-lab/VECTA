import type { ReactNode } from "react";
import type { DashboardDataStatus } from "@/lib/dashboard/aggregates";

/**
 * Shared card shell for Phase 7 dashboard content: renders the data itself,
 * an explicit "unauthorized for this card" state, or an explicit "retrieval
 * failed" state -- never a bare zero when the underlying call didn't
 * actually succeed. A card that legitimately has zero data still renders
 * its children (a "0" is real content), and always shows a last-updated
 * timestamp so staleness is visible.
 */
export function DashboardCard({
  title,
  status,
  generatedAt,
  children,
}: {
  title: string;
  status: DashboardDataStatus;
  generatedAt?: string | null;
  children?: ReactNode;
}) {
  return (
    <section className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">{title}</h2>
        {status === "ok" && generatedAt && (
          <span className="font-mono text-[10px] text-muted-foreground" title="Last updated">
            {new Date(generatedAt).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      {status === "unauthorized" && (
        <p className="font-mono text-xs text-muted-foreground italic" role="status">
          Not authorized for this scope.
        </p>
      )}
      {status === "error" && (
        <p className="font-mono text-xs text-red-500" role="alert">
          Could not load this data right now. Try again shortly.
        </p>
      )}
      {status === "ok" && children}
    </section>
  );
}

export function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2 min-w-[7rem]">
      <p className="font-mono text-2xl font-bold text-foreground" aria-label={`${label}: ${value}`}>
        {value}
      </p>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}
