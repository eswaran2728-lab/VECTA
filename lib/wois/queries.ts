import { createClient } from "@/lib/supabase/server";
import type { WoisConversation, WoisMessage, WoisSourceCitation } from "@/lib/avsec/types";

/**
 * Fetch all chat conversations for the current user.
 */
export async function getWoisConversations(): Promise<WoisConversation[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await supabase
    .from("wois_conversations")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error || !data) return [];
  return data as WoisConversation[];
}

/**
 * Fetch messages for a specific conversation.
 */
export async function getWoisConversationMessages(
  conversationId: string
): Promise<WoisMessage[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("wois_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];
  return data.map((m) => ({
    id: m.id,
    conversation_id: m.conversation_id,
    sender: m.sender as "user" | "assistant",
    body: m.body,
    confidence_tag: (m.confidence_tag as WoisMessage["confidence_tag"]) || undefined,
    source_type: (m.source_type as WoisMessage["source_type"]) || undefined,
    sources: (m.sources as unknown as WoisSourceCitation[]) || [],
    created_at: m.created_at,
  }));
}
