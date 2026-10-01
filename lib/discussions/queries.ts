import { createClient } from "@/lib/supabase/server";
import type {
  DiscussionCategory,
  DiscussionThreadSummary,
  DiscussionThreadDetail,
  DiscussionReply,
  DiscussionReport,
} from "./types";

/**
 * Fetch available discussion categories in scope for the active user.
 */
export async function getDiscussionCategories(): Promise<DiscussionCategory[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_discussion_categories_secure");
  if (error) {
    console.error("Error fetching discussion categories:", error.message);
    return [];
  }
  return (data as DiscussionCategory[]) || [];
}

/**
 * Fetch thread summaries, optionally filtered by category.
 * Result contains ONLY anonymous aliases, never profile IDs.
 */
export async function getDiscussionThreads(
  categoryId?: string | null
): Promise<DiscussionThreadSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_discussion_threads_secure", {
    p_category_id: categoryId || null,
  });
  if (error) {
    console.error("Error fetching discussion threads:", error.message);
    return [];
  }
  return (data as DiscussionThreadSummary[]) || [];
}

/**
 * Fetch complete thread detail including replies.
 * Anonymous by construction at the database RPC layer.
 */
export async function getDiscussionThread(
  threadId: string
): Promise<DiscussionThreadDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_discussion_thread_secure", {
    p_thread_id: threadId,
  });

  if (error || !data || data.length === 0) {
    return null;
  }

  // First row has the thread details
  const first = data[0];
  const replies: DiscussionReply[] = [];

  for (const row of data) {
    if (row.reply_id) {
      replies.push({
        id: row.reply_id,
        body: row.reply_body ?? "",
        author_alias: row.reply_author_alias ?? "",
        status: (row.reply_status as "visible" | "removed") ?? "visible",
        created_at: row.reply_created_at ?? "",
        edited_at: row.reply_edited_at ?? null,
      });
    }
  }

  return {
    id: first.id,
    category_id: first.category_id,
    title: first.title,
    body: first.body,
    author_alias: first.author_alias,
    status: first.status as "open" | "locked" | "removed",
    created_at: first.created_at,
    edited_at: first.edited_at ?? null,
    replies,
  };
}

/**
 * Fetch the IDs of content authored by the current user within a specific thread.
 * Returns only IDs, never exposing other participants' identities.
 */
export async function getMyDiscussionAuthoredIds(threadId: string): Promise<{
  isThreadOwner: boolean;
  ownedReplyIds: string[];
}> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_discussion_authored_ids_secure", {
    p_thread_id: threadId,
  });

  if (error || !data) {
    return { isThreadOwner: false, ownedReplyIds: [] };
  }

  let isThreadOwner = false;
  const ownedReplyIds: string[] = [];

  for (const item of data as { content_type: string; content_id: string }[]) {
    if (item.content_type === "thread") {
      isThreadOwner = true;
    } else if (item.content_type === "reply") {
      ownedReplyIds.push(item.content_id);
    }
  }

  return { isThreadOwner, ownedReplyIds };
}

/**
 * Check if the active user holds the discussion moderator privilege.
 */
export async function getIsDiscussionModerator(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_is_discussion_moderator_secure");
  if (error) {
    return false;
  }
  return Boolean(data);
}

/**
 * Privileged: List moderation reports.
 */
export async function getDiscussionReports(): Promise<DiscussionReport[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_discussion_reports_secure");
  if (error) {
    console.error("Error fetching discussion reports:", error.message);
    return [];
  }
  return (data as DiscussionReport[]) || [];
}
