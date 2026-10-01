import { createClient } from "@/lib/supabase/server";
import type { WoisConversation, WoisMessage, WoisSourceCitation, WoisToolCall } from "@/lib/avsec/types";

/**
 * Fetch all chat conversations for the current user.
 * Phase 12: routed through list_wois_conversations_secure() rather than a
 * raw table select -- the RPC already excludes soft-deleted conversations
 * and is the same ownership-scoped path the write RPCs use, so there is a
 * single authoritative definition of "this user's conversations" rather
 * than two (one in RLS, one re-derived here).
 */
export async function getWoisConversations(): Promise<WoisConversation[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await supabase.rpc("list_wois_conversations_secure");
  if (error || !data) return [];
  return data as WoisConversation[];
}

/**
 * Fetch messages for a specific conversation. Ownership is enforced inside
 * list_wois_messages_secure() -- a conversation id belonging to another
 * user (or another AOC) returns a denial, never another user's messages.
 */
export async function getWoisConversationMessages(
  conversationId: string
): Promise<WoisMessage[]> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("list_wois_messages_secure", {
    p_conversation_id: conversationId,
  });

  if (error || !data) return [];
  return data.map((m) => ({
    id: m.id,
    conversation_id: conversationId,
    sender: m.sender as "user" | "assistant",
    body: m.body,
    confidence_tag: (m.confidence_tag as WoisMessage["confidence_tag"]) || undefined,
    source_type: (m.source_type as WoisMessage["source_type"]) || undefined,
    sources: (m.sources as unknown as WoisSourceCitation[]) || [],
    toolCalls: (m.tool_calls as unknown as WoisToolCall[]) || [],
    created_at: m.created_at,
  }));
}
