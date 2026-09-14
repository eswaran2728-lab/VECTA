"use server";

import { createClient } from "@/lib/supabase/server";
import { executeWoisQuery, type UserContext } from "./engine";
import type { WoisEngineResponse, WoisMessage } from "@/lib/avsec/types";

/**
 * Create a new conversation and post initial user message.
 */
export async function sendWoisMessage(input: {
  conversationId?: string | null;
  message: string;
  userContext?: UserContext;
}): Promise<{
  conversationId: string;
  userMessage: WoisMessage;
  assistantMessage: WoisMessage;
  engineResponse: WoisEngineResponse;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Authentication required");
  }

  // Determine or create conversation
  let convId = input.conversationId;

  if (!convId) {
    // Generate brief title from first message
    const title = input.message.length > 30 ? input.message.slice(0, 30) + "..." : input.message;
    const { data: newConv, error: convError } = await supabase
      .from("wois_conversations")
      .insert({
        user_id: user.id,
        title: title || "New Chat",
      })
      .select()
      .single();

    if (convError || !newConv) {
      throw new Error(`Failed to create conversation: ${convError?.message}`);
    }
    convId = newConv.id;
  }

  // Insert user message
  const { data: userMsg, error: userMsgError } = await supabase
    .from("wois_messages")
    .insert({
      conversation_id: convId,
      sender: "user",
      body: input.message,
    })
    .select()
    .single();

  if (userMsgError || !userMsg) {
    throw new Error(`Failed to save user message: ${userMsgError?.message}`);
  }

  // Execute intelligence reasoning
  const engineResponse = await executeWoisQuery(input.message, input.userContext || {});

  // Insert assistant response
  const { data: assistantMsg, error: astMsgError } = await supabase
    .from("wois_messages")
    .insert({
      conversation_id: convId,
      sender: "assistant",
      body: engineResponse.body,
      confidence_tag: engineResponse.confidence_tag,
      source_type: engineResponse.source_type,
      sources: JSON.parse(JSON.stringify(engineResponse.sources)),
    })
    .select()
    .single();

  if (astMsgError || !assistantMsg) {
    throw new Error(`Failed to save assistant response: ${astMsgError?.message}`);
  }

  // Update conversation updated_at
  await supabase
    .from("wois_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", convId);

  return {
    conversationId: convId,
    userMessage: {
      id: userMsg.id,
      conversation_id: convId,
      sender: "user",
      body: userMsg.body,
      created_at: userMsg.created_at,
    },
    assistantMessage: {
      id: assistantMsg.id,
      conversation_id: convId,
      sender: "assistant",
      body: assistantMsg.body,
      confidence_tag: engineResponse.confidence_tag,
      source_type: engineResponse.source_type,
      sources: engineResponse.sources,
      created_at: assistantMsg.created_at,
    },
    engineResponse,
  };
}

/**
 * Delete a conversation.
 */
export async function deleteWoisConversation(conversationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Authentication required");

  await supabase
    .from("wois_conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", user.id);
}
