import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWoisProvider, RuleEngineProvider } from "@/lib/wois/provider";
import { getWoisRateLimiter } from "@/lib/wois/rate-limit";
import { runWoisOrchestrator } from "@/lib/wois/orchestrator";
import { getWoisAiConfig } from "@/lib/wois/config";
import { getWoisEligibility } from "@/lib/wois/eligibility";
import { executeWoisTool, isKnownWoisTool } from "@/lib/wois/tools";
import type { ConversationTurn } from "@/lib/wois/engine";

// Bounded conversation/output, independent of (and never looser than) the
// orchestrator's own config-driven bounds.
const MAX_INPUT_LENGTH = 2000;
const MAX_OUTPUT_LENGTH = 6000;

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

    // Identity and scope are never taken from the request body: the server derives everything from the authenticated session.
    const { message, conversationId } = (body ?? {}) as {
      message?: unknown;
      conversationId?: unknown;
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

    const config = getWoisAiConfig();

    // Server-side rate limit, keyed by the authenticated user (checked after validation, before any provider or conversation work).
    const limit = getWoisRateLimiter().check(user.id);
    if (!limit.allowed) {
      void supabase.rpc("record_wois_audit_event_secure", {
        p_event_type: "rate_limited",
        p_conversation_id: null,
        p_details: { limit: config.rateLimitMax, window_seconds: Math.round(config.rateLimitWindowMs / 1000) },
      });
      return NextResponse.json(
        { error: "Too many W.O.I.S requests. Please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }

    // Resolve/create the conversation via secure RPCs -- never a raw insert.
    let convId = typeof conversationId === "string" ? conversationId : null;
    let history: ConversationTurn[] = [];

    if (convId) {
      const { data: existingMessages, error: historyError } = await supabase.rpc("list_wois_messages_secure", {
        p_conversation_id: convId,
      });
      if (historyError) {
        // Ownership/eligibility failed inside the RPC -- fail closed rather
        // than silently starting a new conversation under someone else's id.
        return NextResponse.json({ error: "Conversation not found or not accessible." }, { status: 403 });
      }
      history = (existingMessages ?? [])
        .slice(-config.maxHistoryMessages)
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

    const provider = await getWoisProvider();

    const { response: engineResponse, toolCalls, usedFallback, fallbackReason } = await runWoisOrchestrator(message, {
      provider,
      fallbackProvider: provider.name === "rule_engine" ? undefined : new RuleEngineProvider(),
      history,
      userContext: {},
      maxToolCalls: config.maxToolCalls,
      timeoutMs: config.timeoutMs,
      signal: req.signal,
      executeTool: async (toolName) => {
        if (!isKnownWoisTool(toolName)) {
          return { ok: false, summary: "That action is not available." };
        }
        const result = await executeWoisTool(toolName, supabase);
        return { ok: result.ok, summary: result.summary };
      },
      onToolCall: (toolName, ok) => {
        void supabase.rpc("record_wois_audit_event_secure", {
          p_event_type: ok ? "tool_invoked" : "tool_denied",
          p_conversation_id: convId,
          p_details: { tool: toolName },
        });
      },
    });

    if (usedFallback && provider.name !== "rule_engine") {
      await supabase.rpc("record_wois_audit_event_secure", {
        p_event_type: "provider_failure",
        p_conversation_id: convId,
        p_details: { provider: provider.name, reason: fallbackReason ?? "provider_error" },
      });
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
      p_provider: usedFallback ? "rule_engine" : provider.name,
      p_model: usedFallback ? "wois-rule-engine-v1" : provider.model,
    });

    return NextResponse.json({
      conversationId: convId,
      response: {
        ...engineResponse,
        body: responseBody,
        toolCalls,
        provider: usedFallback ? "rule_engine" : provider.name,
        usedFallback,
        ...(usedFallback ? { fallbackReason: fallbackReason ?? "provider_error" } : {}),
      },
    });
  } catch (error: unknown) {
    console.error("[wois/chat] request failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Failed to process query." }, { status: 500 });
  }
}
