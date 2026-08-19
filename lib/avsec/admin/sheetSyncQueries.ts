import { createClient } from "@/lib/supabase/server";

export interface SheetSyncConfig {
  webhook_url: string | null;
  webhook_secret: string | null;
  enabled: boolean;
  updated_at: string;
}

export interface SheetSyncQueueItem {
  id: string;
  report_type: string;
  report_id: string;
  report_no: string | null;
  status: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface SheetSyncCounts {
  pending: number;
  sent: number;
  failed: number;
}

export async function getSheetSyncConfig(): Promise<SheetSyncConfig | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sheet_sync_config")
    .select("webhook_url, webhook_secret, enabled, updated_at")
    .eq("id", true)
    .maybeSingle();
  return (data as SheetSyncConfig) ?? null;
}

export async function getSheetSyncCounts(): Promise<SheetSyncCounts> {
  const supabase = await createClient();
  const [pending, sent, failed] = await Promise.all([
    supabase.from("sheet_sync_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("sheet_sync_queue").select("id", { count: "exact", head: true }).eq("status", "sent"),
    supabase.from("sheet_sync_queue").select("id", { count: "exact", head: true }).eq("status", "failed"),
  ]);
  return {
    pending: pending.count ?? 0,
    sent: sent.count ?? 0,
    failed: failed.count ?? 0,
  };
}

export async function getRecentFailedSyncs(limit = 20): Promise<SheetSyncQueueItem[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("sheet_sync_queue")
    .select("*")
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as SheetSyncQueueItem[]) ?? [];
}
