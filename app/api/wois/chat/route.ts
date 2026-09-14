import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeWoisQuery } from "@/lib/wois/engine";
import { executeWoisQueryConversational } from "@/lib/wois/llm";

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { message, conversationId, userContext } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    // Pull recent turns (if any) so the conversational layer has context, same as
    // a real chat assistant — the rule-based fallback below ignores history entirely.
    let priorMessages: { sender: "user" | "assistant"; body: string }[] = [];
    if (conversationId) {
      const { data: history } = await supabase
        .from("wois_messages")
        .select("sender, body")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(20);
      priorMessages = history ?? [];
    }

    const engineResponse = await executeWoisQueryConversational(
      message,
      priorMessages,
      userContext || {},
      () => executeWoisQuery(message, userContext || {}),
    );

    // Save to conversation if conversationId is provided or created
    let convId = conversationId;
    if (!convId) {
      const title = message.length > 30 ? message.slice(0, 30) + "..." : message;
      const { data: newConv } = await supabase
        .from("wois_conversations")
        .insert({
          user_id: user.id,
          title,
        })
        .select()
        .single();

      if (newConv) {
        convId = newConv.id;
      }
    }

    if (convId) {
      await supabase.from("wois_messages").insert([
        {
          conversation_id: convId,
          sender: "user",
          body: message,
        },
        {
          conversation_id: convId,
          sender: "assistant",
          body: engineResponse.body,
          confidence_tag: engineResponse.confidence_tag,
          source_type: engineResponse.source_type,
          sources: JSON.parse(JSON.stringify(engineResponse.sources)),
        },
      ]);

      await supabase
        .from("wois_conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", convId);
    }

    return NextResponse.json({
      conversationId: convId,
      response: engineResponse,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process query";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
