import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWoisProvider, woisUnavailableResponse, type WoisProviderContext } from "@/lib/wois/provider";
import type { ConversationTurn } from "@/lib/wois/engine";
import { getWoisEligibility } from "@/lib/wois/eligibility";
import { executeWoisTool, matchWoisToolIntent } from "@/lib/wois/tools";
import type { WoisToolCall } from "@/lib/avsec/types";

// Bounded conversation/history/output -- see Phase 12 AI-safety requirements.
const MAX_INPUT_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_OUTPUT_LENGTH = 6000;
const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider_timeout")), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Eligibility is re-checked on every request -- never cached, never
    // trusted from a prior response. Fails closed for any non-Malaysia-AOC
    // or non-active/non-approved caller.
    const eligibility = await getWoisEligibility();
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: "WOIS AI is not available for your account.", reason: eligibility.reason },
        { status: 403 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
    }

    const { message, conversationId, userContext } = (body ?? {}) as {
      message?: unknown;
      conversationId?: unknown;
      userContext?: unknown;
    };

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }
    if (message.length > MAX_INPUT_LENGTH) {
      return NextResponse.json({ error: "Message is too long" }, { status: 400 });
    }
    if (conversationId !== undefined && conversationId !== null && typeof conversationId !== "string") {
      return NextResponse.json({ error: "Invalid conversationId" }, { status: 400 });
    }

    const safeUserContext =
      userContext && typeof userContext === "object" && !Array.isArray(userContext)
        ? (userContext as Record<string, unknown>)
        : {};

    // Resolve/create the conversation via secure RPCs -- never a raw insert.
    let convId = typeof conversationId === "string" ? conversationId : null;
    let history: ConversationTurn[] = [];

    if (convId) {
      const { data: existingMessages, error: historyError } = await supabase.rpc("list_wois_messages_secure", {
        p_conversation_id: convId,
      });
      if (historyError) {
        // Ownership/ eligibility failed inside the RPC -- fail closed rather
        // than silently starting a new conversation under someone else's id.
        return NextResponse.json({ error: "Conversation not found or not accessible." }, { status: 403 });
      }
      history = (existingMessages ?? [])
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.sender as "user" | "assistant", content: m.body }));
    } else {
      const title = message.length > 40 ? message.slice(0, 40) + "..." : message;
      const { data: newConvId, error: createError } = await supabase.rpc("create_wois_conversation_secure", {
        p_title: title,
      });
      if (createError || !newConvId) {
        return NextResponse.json({ error: "Could not start a new conversation." }, { status: 403 });
      }
      convId = newConvId;
    }

    // Tool-intent detection -- deterministic, allowlisted, at most one tool
    // call per turn in this phase. Every tool call re-derives the caller
    // from this request's own authenticated Supabase client; nothing in
    // `message` or `userContext` is ever passed into a tool argument.
    const toolCalls: WoisToolCall[] = [];
    const toolIntent = matchWoisToolIntent(message);
    let toolAnsweredBody: string | null = null;

    if (toolIntent) {
      const toolResult = await executeWoisTool(toolIntent, supabase);
      await supabase.rpc("record_wois_audit_event_secure", {
        p_event_type: toolResult.ok ? "tool_invoked" : "tool_denied",
        p_conversation_id: convId,
        p_details: { tool: toolIntent },
      });
      toolCalls.push({ tool: toolIntent, resultSummary: toolResult.summary });
      if (toolResult.ok) {
        toolAnsweredBody = toolResult.summary;
      }
    }

    let engineResponse;
    if (toolAnsweredBody) {
      engineResponse = {
        body: toolAnsweredBody,
        confidence_tag: "VERIFIED" as const,
        source_type: "app_help" as const,
        sources: [
          {
            documentTitle: "Your VECTA account",
            sectionTitle: "Authenticated user record",
            sourceType: "app_help" as const,
          },
        ],
      };
    } else {
      const provider = getWoisProvider();
      const ctx: WoisProviderContext = {
        history,
        userContext: safeUserContext,
      };
      try {
        engineResponse = await withTimeout(provider.generate(message, ctx), PROVIDER_TIMEOUT_MS);
      } catch {
        await supabase.rpc("record_wois_audit_event_secure", {
          p_event_type: "provider_failure",
          p_conversation_id: convId,
          p_details: { provider: provider.name },
        });
        engineResponse = woisUnavailableResponse();
      }
    }

    const responseBody =
      engineResponse.body.length > MAX_OUTPUT_LENGTH
        ? engineResponse.body.slice(0, MAX_OUTPUT_LENGTH) + "\n\n(Response truncated.)"
        : engineResponse.body;

    await supabase.rpc("append_wois_message_secure", {
      p_conversation_id: convId,
      p_sender: "user",
      p_body: message,
    });

    await supabase.rpc("append_wois_message_secure", {
      p_conversation_id: convId,
      p_sender: "assistant",
      p_body: responseBody,
      p_confidence_tag: engineResponse.confidence_tag,
      p_source_type: engineResponse.source_type,
      p_sources: JSON.parse(JSON.stringify(engineResponse.sources ?? [])),
      p_tool_calls: JSON.parse(JSON.stringify(toolCalls)),
    });

    return NextResponse.json({
      conversationId: convId,
      response: { ...engineResponse, body: responseBody, toolCalls },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process query";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
