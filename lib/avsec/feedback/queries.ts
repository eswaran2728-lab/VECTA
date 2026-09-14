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
 * Fetch Management Feedback Inbox from the privacy view (omits submitter_id entirely).
 */
export async function getManagementFeedbackInbox(filters?: {
  category?: FeedbackCategory;
  status?: "open" | "closed";
}): Promise<ManagementFeedbackThreadView[]> {
  const supabase = await createClient();

  let query = supabase
    .from("feedback_threads_management_view")
    .select("*")
    .order("updated_at", { ascending: false });

  if (filters?.category) {
    query = query.eq("category", filters.category);
  }
  if (filters?.status) {
    query = query.eq("status", filters.status);
  }

  const { data: threads } = await query;
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

  const { data } = await supabase
    .from("feedback_threads_management_view")
    .select("category, status")
    .eq("status", "open");

  const rows = data ?? [];
  const totalOpen = rows.length;
  const urgentSafetyCount = rows.filter((r) => r.category === "safety_concern").length;

  return { totalOpen, urgentSafetyCount };
}
