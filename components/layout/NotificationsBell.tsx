"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { reportViewHref, REPORT_TYPE_OPTIONS } from "@/lib/dashboard/entity-report-filters";

/** One row of get_my_notifications(): the caller's own durable in-app events. */
type NotificationRow = { id: string; event_type: string; payload: unknown; created_at: string; read_at: string | null };

type AppNotification = { id: string; title: string; body: string; isRead: boolean; createdAt: string; href: string | null };

const REFRESH_MS = 60_000;

const TITLES: Record<string, string> = {
  entity_report_submitted: "New entity report",
  request_submitted: "Registration request submitted",
  request_approved: "Registration approved",
  request_rejected: "Registration rejected",
  transfer_initiated: "Transfer initiated",
  transfer_accepted: "Transfer accepted",
  transfer_rejected: "Transfer rejected",
  membership_ended: "Membership ended",
  assignment_ended: "Assignment ended",
  deactivation: "Account deactivated",
  caterlink_movement_received: "CaterLink movement received",
};

function humanize(eventType: string): string {
  const s = eventType.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function toAppNotification(r: NotificationRow): AppNotification {
  const payload = (r.payload ?? {}) as { source_table?: string; source_id?: string; transaction_id?: string };
  let body = "";
  let href: string | null = null;
  if (r.event_type === "entity_report_submitted") {
    body = REPORT_TYPE_OPTIONS.find((o) => o.value === payload.source_table)?.label ?? "Report";
    // The link opens the report through the secure route, which authorizes again; the payload carries identifiers only.
    href = payload.source_table && payload.source_id ? reportViewHref(payload.source_table, payload.source_id) : null;
  }
  return { id: r.id, title: TITLES[r.event_type] ?? humanize(r.event_type), body, isRead: r.read_at !== null, createdAt: r.created_at, href };
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Shared in-app notification bell (AVSEC and ICMS shells). It uses ONLY the caller-scoped, SECURITY DEFINER notification API:
 * get_my_notifications() lists the signed-in user's own durable events and mark_notification_read() marks one of their own rows.
 * Identity is never sent from the browser (both functions derive it from auth.uid()), no table is read directly, and no realtime
 * subscription to a table is opened -- the list refreshes when the dropdown opens and every minute. Destination pages
 * re-authorize on load; a link here is navigation only, never authorization.
 *
 * `userId` is used only to reset local state when the signed-in user changes; it is not sent anywhere.
 */
export function useNotifications(userId: string) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (): Promise<AppNotification[]> => {
    const { data, error: rpcError } = await createClient().rpc("get_my_notifications", { p_limit: 30 });
    setLoading(false);
    if (rpcError) {
      setError(true);
      return [];
    }
    setError(false);
    const list = (data ?? []).map((r) => toAppNotification(r));
    setItems(list);
    return list;
  }, []);

  useEffect(() => {
    setItems([]);
    setLoading(true);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [userId, load]);

  const unread = items.filter((n) => !n.isRead).length;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    const fresh = await load();
    const unreadIds = fresh.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length > 0) {
      setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
      const supabase = createClient();
      await Promise.all(unreadIds.map((id) => supabase.rpc("mark_notification_read", { p_notification_id: id })));
    }
  };

  return { items, open, setOpen, loading, error, unread, toggle };
}

/** The notification rows, shared by the desktop dropdown and the mobile Alerts sheet. */
export function NotificationsList({ items, loading, error, onNavigate }: { items: AppNotification[]; loading: boolean; error: boolean; onNavigate: () => void }) {
  if (loading) return <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground" role="alert">
        Couldn&apos;t load notifications. Try again shortly.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground" role="status">
        Nothing yet.
      </p>
    );
  }
  return (
    <ul className="max-h-96 divide-y divide-border overflow-y-auto">
      {items.map((n) => {
        const content = (
          <>
            <span className="font-medium">{n.title}</span>
            {n.body ? <span className="block text-xs text-muted-foreground">{n.body}</span> : null}
            <span className="block text-[11px] text-muted-foreground">{formatDateTime(n.createdAt)}</span>
          </>
        );
        return (
          <li key={n.id} className="px-2 py-2 text-sm">
            {n.href ? (
              <Link href={n.href} onClick={onNavigate} className="block min-h-[44px]">
                {content}
              </Link>
            ) : (
              <div>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function NotificationsBell({ userId, tone = "surface" }: { userId: string; tone?: "surface" | "shell" }) {
  const { items, open, setOpen, loading, error, unread, toggle } = useNotifications(userId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className={`relative flex items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${tone === "shell" ? "h-11 w-11 text-shell-muted hover:bg-white/5 hover:text-shell-foreground" : "h-11 w-11 text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:h-9 sm:w-9"}`}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-foreground">
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={`z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-2 text-card-foreground shadow-lg ${tone === "shell" ? "vecta-rail-flyout fixed bottom-4" : "absolute right-0 top-12 sm:top-11"}`}>
          <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Notifications</p>
          <NotificationsList items={items} loading={loading} error={error} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
