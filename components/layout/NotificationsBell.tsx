"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { markNotificationsRead } from "@/lib/notifications/actions";
import { reportViewHref, REPORT_TYPE_OPTIONS } from "@/lib/dashboard/entity-report-filters";

type AppNotification = {
  id: string;
  user_id: string;
  incident_id: string | null;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
  /** Set for entity-report notifications: opening goes through the secure report route, which re-authorizes. */
  href?: string | null;
  /** Which table the row came from (so read-marking targets the right one). */
  source?: "legacy" | "entity";
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Deep link authorization note: notifications are RLS-scoped to `user_id`, so a
 * user only ever sees their own rows here. Destination pages independently
 * re-check role/record access on load — this link is a navigation shortcut,
 * never itself a source of authorization. */
function destinationFor(n: AppNotification): string {
  if (n.href) return n.href;
  return n.incident_id ? "/icms/incidents" : "/avsec/dashboard";
}

/**
 * Shared in-app notification bell: unread badge + dropdown, updated live via
 * Supabase realtime on the `notifications` table. Rendered from both the
 * AVSEC and ICMS shells (AppSidebar desktop header, UnifiedHeader mobile
 * `extra` slot) so notifications created by either side (feedback,
 * announcements, incident assignment, etc.) are actually visible to their
 * intended recipient, not just to ICMS users.
 */
export function NotificationsBell({ userId }: { userId: string }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(15)
      .then(({ data, error: fetchError }) => {
        setLoading(false);
        if (fetchError) {
          setError(true);
          return;
        }
        setItems((data ?? []).map((r) => ({ ...(r as AppNotification), source: "legacy" as const })));
      });

    // Entity report notifications (MAA/AAX leadership). The payload carries identifiers only; the row is RLS-scoped to the
    // recipient and the link opens the report through the secure route, which authorizes again.
    supabase
      .from("user_notifications")
      .select("id, event_type, payload, created_at, read_at")
      .eq("recipient_profile_id", userId)
      .eq("event_type", "entity_report_submitted")
      .order("created_at", { ascending: false })
      .limit(15)
      .then(({ data }) => {
        const mapped: AppNotification[] = (data ?? []).map((r) => {
          const payload = (r.payload ?? {}) as { source_table?: string; source_id?: string };
          const label = REPORT_TYPE_OPTIONS.find((o) => o.value === payload.source_table)?.label ?? "Report";
          return {
            id: `entity:${r.id}`,
            user_id: userId,
            incident_id: null,
            title: "New entity report",
            body: label,
            is_read: r.read_at !== null,
            created_at: r.created_at,
            href: payload.source_table && payload.source_id ? reportViewHref(payload.source_table, payload.source_id) : null,
            source: "entity" as const,
          };
        });
        if (mapped.length > 0) {
          setItems((prev) => [...prev, ...mapped].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30));
        }
      });

    // Channel name must be unique per mounted instance — the bell can be
    // mounted twice at once (desktop AppSidebar + mobile UnifiedHeader), and
    // Supabase realtime throws if two channels share a name.
    const channel = supabase
      .channel(`vecta-notifications-${userId}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          setItems((prev) => [payload.new as AppNotification, ...prev].slice(0, 15));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const unread = items.filter((n) => !n.is_read).length;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
      await markNotificationsRead();
      await createClient()
        .from("user_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("recipient_profile_id", userId)
        .eq("event_type", "entity_report_submitted")
        .is("read_at", null);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-lg border border-border bg-card p-2 shadow-lg">
          <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Notifications</p>
          {loading ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Couldn&apos;t load notifications. Try again shortly.
            </p>
          ) : items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="px-2 py-2 text-sm">
                  <Link href={destinationFor(n)} onClick={() => setOpen(false)}>
                    <span className="font-medium">{n.title}</span>
                    <span className="block text-xs text-muted-foreground">{n.body}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {formatDateTime(n.created_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
