import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get("conversationId");

    if (conversationId) {
      // Ownership is enforced inside the RPC -- a foreign conversation id
      // returns an error, never another user's messages.
      const { data: messages, error } = await supabase.rpc("list_wois_messages_secure", {
        p_conversation_id: conversationId,
      });
      if (error) {
        return NextResponse.json({ error: "Conversation not found or not accessible." }, { status: 403 });
      }
      return NextResponse.json({ messages: messages || [] });
    }

    // Excludes soft-deleted conversations -- see list_wois_conversations_secure().
    const { data: conversations } = await supabase.rpc("list_wois_conversations_secure");

    return NextResponse.json({ conversations: conversations || [] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch history";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
