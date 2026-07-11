"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { markNotificationsRead } from "@/lib/actions/incidents";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import type { AppNotification } from "@/lib/database.types";

/**
 * In-app incident notifications: unread badge + dropdown, updated live via
 * Supabase realtime on the notifications table (RLS scopes rows to the user).
 */
export function NotificationsBell({ userId }: { userId: string }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(15)
      .then(({ data }) => setItems((data ?? []) as AppNotification[]));

    const channel = supabase
      .channel("cscs-notifications")
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
      await markNotificationsRead();
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    }
  };

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Notifications">
        <Bell className="h-5 w-5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div className="absolute right-0 top-11 z-50 w-80 rounded-lg border bg-card p-2 shadow-lg">
          <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Notifications</p>
          {items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="px-2 py-2 text-sm">
                  <Link href="/incidents" onClick={() => setOpen(false)}>
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
