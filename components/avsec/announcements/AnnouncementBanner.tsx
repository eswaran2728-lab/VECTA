"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { acknowledgeAnnouncement } from "@/lib/avsec/announcements/actions";
import { cn } from "@/lib/avsec/utils";
import type { AnnouncementWithStatus } from "@/lib/avsec/types";
import { Megaphone, CheckCircle2, ChevronDown, ChevronUp, Loader2, Bell } from "lucide-react";

export function AnnouncementBanner({
  announcements,
}: {
  announcements: AnnouncementWithStatus[];
}) {
  const [items, setItems] = useState(announcements);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) return null;

  const unacknowledged = items.filter((a) => !a.acknowledged);
  const acknowledged = items.filter((a) => a.acknowledged);

  const handleAcknowledge = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setAcknowledgingId(id);
    const res = await acknowledgeAnnouncement(id);
    if (res.ok) {
      setItems((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, acknowledged: true, acknowledged_at: new Date().toISOString() }
            : a
        )
      );
    } else {
      alert(res.error || "Failed to acknowledge announcement");
    }
    setAcknowledgingId(null);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="space-y-3">
      {/* Unacknowledged Announcements (Prominent Action Cards) */}
      {unacknowledged.map((a) => {
        const isExp = expanded[a.id];
        const isAcking = acknowledgingId === a.id;

        return (
          <div
            key={a.id}
            className="p-4 rounded-xl border border-primary/40 bg-primary/10 shadow-sm transition-all"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-primary/20 text-primary shrink-0 mt-0.5">
                  <Megaphone className="h-5 w-5" />
                </div>

                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-primary text-primary-foreground">
                      Action Required
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {formatDateTimeMY(a.created_at)}
                    </span>
                  </div>

                  <h3 className="font-display font-bold text-base text-foreground">
                    {a.title}
                  </h3>

                  <p
                    className={cn(
                      "text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap",
                      !isExp && "line-clamp-2"
                    )}
                  >
                    {a.body}
                  </p>

                  {a.body.length > 150 && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(a.id)}
                      className="text-xs font-mono text-primary hover:underline flex items-center gap-0.5 pt-0.5"
                    >
                      <span>{isExp ? "Show less" : "Read full message"}</span>
                      {isExp ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              </div>

              <div className="sm:self-center shrink-0 pt-2 sm:pt-0">
                <button
                  type="button"
                  disabled={isAcking}
                  onClick={(e) => handleAcknowledge(a.id, e)}
                  className="btn-primary w-full sm:w-auto text-xs px-4 py-2 flex items-center justify-center gap-1.5 shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {isAcking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  <span>Acknowledge</span>
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Acknowledged Announcements (Collapsible History) */}
      {acknowledged.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="text-xs font-mono text-muted-foreground hover:text-foreground flex items-center gap-1 py-1"
          >
            <Bell className="h-3.5 w-3.5" />
            <span>
              {acknowledged.length} previous announcement{acknowledged.length === 1 ? "" : "s"} (acknowledged)
            </span>
            {showAll ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>

          {showAll && (
            <div className="space-y-2 pt-2">
              {acknowledged.map((a) => {
                const isExp = expanded[a.id];
                return (
                  <div
                    key={a.id}
                    className="card p-3.5 border-border/70 bg-surface/70 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-foreground">{a.title}</h4>
                      <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        Acknowledged
                      </span>
                    </div>
                    <p className={cn("text-muted-foreground leading-relaxed whitespace-pre-wrap", !isExp && "line-clamp-1")}>
                      {a.body}
                    </p>
                    {a.body.length > 100 && (
                      <button
                        type="button"
                        onClick={() => toggleExpand(a.id)}
                        className="text-[11px] font-mono text-primary hover:underline"
                      >
                        {isExp ? "Collapse" : "Expand"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
