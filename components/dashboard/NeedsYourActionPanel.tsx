import Link from "next/link";
import type { ActionItem } from "@/lib/dashboard/needs-your-action";

export function NeedsYourActionPanel({ items }: { items: ActionItem[] }) {
  if (items.length === 0) return null;

  const grouped = new Map<string, ActionItem[]>();
  for (const item of items) {
    grouped.set(item.category, [...(grouped.get(item.category) ?? []), item]);
  }

  return (
    <section className="card p-4 border-l-4 border-l-amber-500 bg-amber-500/5 space-y-3">
      <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-amber-500 flex items-center gap-2">
        ⚡ Needs Your Action
        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 border border-amber-500/30">
          {items.length}
        </span>
      </h2>
      <div className="space-y-4">
        {Array.from(grouped.entries()).map(([category, categoryItems]) => (
          <div key={category}>
            <p className="font-mono text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">
              {category} ({categoryItems.length})
            </p>
            <div className="divide-y divide-border/60">
              {categoryItems.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="flex items-center justify-between py-2 hover:bg-card/40 group"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors truncate">
                      {item.title}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground truncate">{item.detail}</p>
                  </div>
                  <span className="font-mono text-xs text-primary shrink-0 ml-3">View →</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
