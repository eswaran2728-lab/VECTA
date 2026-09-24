import { createClient } from "@/lib/supabase/server";
import type {
  FeedbackCategory,
  FeedbackMessageRow,
  FeedbackThreadRow,
  ManagementFeedbackThreadView,
} from "@/lib/avsec/types";

/**
 * Fetch staff member's own feedback threads with latest message snippet and count.
 */
export async function getMyFeedbackThreads(
  profileId: string
): Promise<(FeedbackThreadRow & { last_message?: string; message_count: number })[]> {
  const supabase = await createClient();

  const { data: threads } = await supabase
    .from("feedback_threads")
    .select("*")
    .eq("submitter_id", profileId)
    .order("updated_at", { ascending: false });

  if (!threads || threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);

  const { data: messages } = await supabase
    .from("feedback_messages")
    .select("*")
    .in("thread_id", threadIds)
    .order("created_at", { ascending: true });

  const msgMap = new Map<string, FeedbackMessageRow[]>();
  (messages ?? []).forEach((m) => {
    const list = msgMap.get(m.thread_id) || [];
    list.push(m as FeedbackMessageRow);
    msgMap.set(m.thread_id, list);
  });

  return (threads as FeedbackThreadRow[]).map((t) => {
    const msgs = msgMap.get(t.id) || [];
    const lastMsg = msgs[msgs.length - 1]?.body;
    return {
      ...t,
      last_message: lastMsg,
      message_count: msgs.length,
    };
  });
}

/**
 * Fetch Management Feedback Inbox via the approved-Management-gated RPC
 * (omits submitter_id entirely). The underlying view is no longer directly
 * SELECT-able by `authenticated` (2026-09-24) -- get_management_feedback_threads()
 * returns rows only when is_approved_management() is true for the caller,
 * empty otherwise, so this call site needs no role check of its own.
 */
export async function getManagementFeedbackInbox(filters?: {
  category?: FeedbackCategory;
  status?: "open" | "closed";
}): Promise<ManagementFeedbackThreadView[]> {
  const supabase = await createClient();

  const { data: rpcThreads } = await supabase.rpc("get_management_feedback_threads");
  let threads = (rpcThreads ?? []) as ManagementFeedbackThreadView[];

  if (filters?.category) {
    threads = threads.filter((t) => t.category === filters.category);
  }
  if (filters?.status) {
    threads = threads.filter((t) => t.status === filters.status);
  }
  threads = [...threads].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  if (!threads || threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);

  const { data: messages } = await supabase
    .from("feedback_messages")
    .select("*")
    .in("thread_id", threadIds)
    .order("created_at", { ascending: true });

  const msgMap = new Map<string, FeedbackMessageRow[]>();
  (messages ?? []).forEach((m) => {
    const list = msgMap.get(m.thread_id) || [];
    list.push(m as FeedbackMessageRow);
    msgMap.set(m.thread_id, list);
  });

  return (threads as ManagementFeedbackThreadView[]).map((t) => {
    const msgs = msgMap.get(t.id) || [];
    const lastMsg = msgs[msgs.length - 1]?.body;
    return {
      ...t,
      last_message: lastMsg,
      message_count: msgs.length,
    };
  });
}

/**
 * Fetch messages for a specific thread.
 */
export async function getFeedbackThreadMessages(
  threadId: string
): Promise<FeedbackMessageRow[]> {
  const supabase = await createClient();

  const { data: messages } = await supabase
    .from("feedback_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  return (messages as FeedbackMessageRow[]) ?? [];
}

/**
 * Fetch unread stats for Management dashboard badge and safety alerts.
 */
export async function getManagementFeedbackStats(): Promise<{
  totalOpen: number;
  urgentSafetyCount: number;
}> {
  const supabase = await createClient();

  const { data } = await supabase.rpc("get_management_feedback_threads");

  const rows = (data ?? []).filter((r) => r.status === "open");
  const totalOpen = rows.length;
  const urgentSafetyCount = rows.filter((r) => r.category === "safety_concern").length;

  return { totalOpen, urgentSafetyCount };
}
