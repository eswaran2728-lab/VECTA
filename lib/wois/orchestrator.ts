import type { WoisProvider, WoisProviderTurn } from "./provider";
import { woisUnavailableResponse } from "./provider";
import { WOIS_TOOL_SPECS, isKnownWoisTool, type WoisToolName } from "./tools";
import { toolResultToProviderText } from "./redaction";
import type { UserContext, ConversationTurn } from "./engine";
import type { WoisEngineResponse, WoisToolCall } from "@/lib/avsec/types";

/**
 * The bounded multi-turn, multi-tool orchestration loop that sits between
 * a `WoisProvider` and the rest of the app. This is the ONLY place a tool
 * is ever actually invoked -- a provider (including Gemini) can only
 * *request* a tool by name; this loop is what decides whether to honor
 * that request (checking the closed allowlist again, independently of
 * whatever the provider believes is available) and what runs it.
 */
export interface WoisOrchestratorDeps {
  provider: WoisProvider;
  history: ConversationTurn[];
  userContext: UserContext;
  /** Executes one allowlisted tool against the CURRENT request's own
   * authenticated session. The orchestrator never constructs this itself
   * and never receives a Supabase client directly -- the caller (the API
   * route) closes over its own request-scoped client here, so a test can
   * inject a scripted executor with no database at all. */
  executeTool: (toolName: WoisToolName) => Promise<{ ok: boolean; summary: string }>;
  /** Called once per tool invocation for audit purposes, after execution. */
  onToolCall?: (toolName: string, ok: boolean) => void;
  maxToolCalls: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface WoisOrchestratorResult {
  response: WoisEngineResponse;
  toolCalls: WoisToolCall[];
  /** True if the deterministic fallback engine answered instead of the
   * requested provider (timeout, error, invalid response, or the provider
   * was never configured in the first place). */
  usedFallback: boolean;
}

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

export async function runWoisOrchestrator(message: string, deps: WoisOrchestratorDeps): Promise<WoisOrchestratorResult> {
  const toolCalls: WoisToolCall[] = [];
  const providerHistory: WoisProviderTurn[] = deps.history.map((t) => ({ role: t.role, content: t.content }));
  let currentMessage = message;
  const maxToolCalls = Math.max(0, deps.maxToolCalls);

  for (let i = 0; i <= maxToolCalls; i++) {
    let result;
    try {
      result = await withTimeout(
        deps.provider.generate(currentMessage, {
          history: providerHistory,
          userContext: deps.userContext,
          availableTools: WOIS_TOOL_SPECS,
          signal: deps.signal,
        }),
        deps.timeoutMs
      );
    } catch {
      return { response: woisUnavailableResponse(), toolCalls, usedFallback: true };
    }

    if (result.type === "final") {
      return { response: { ...result.response, toolCalls }, toolCalls, usedFallback: false };
    }

    if (result.type === "clarify") {
      return {
        response: {
          body: result.question,
          confidence_tag: "UNCERTAIN",
          source_type: "general",
          sources: [],
          toolCalls,
        },
        toolCalls,
        usedFallback: false,
      };
    }

    // result.type === "tool_call" -- independently re-validate against the
    // closed allowlist. A provider asking for anything else is rejected
    // outright, not silently ignored or substituted.
    if (!isKnownWoisTool(result.tool)) {
      deps.onToolCall?.(result.tool, false);
      return {
        response: {
          body: "I can't do that from here, but I can tell you about your own reports, notifications, announcements, roster, overtime, or role assignments.",
          confidence_tag: "UNCERTAIN",
          source_type: "general",
          sources: [],
          toolCalls,
        },
        toolCalls,
        usedFallback: false,
      };
    }

    if (i === maxToolCalls) {
      // Tool-call limit reached -- stop the loop deterministically rather
      // than ever looping indefinitely.
      return {
        response: {
          body: "I've gathered what I can from your account for this turn. Ask me to continue if you need more.",
          confidence_tag: "UNCERTAIN",
          source_type: "general",
          sources: [],
          toolCalls,
        },
        toolCalls,
        usedFallback: false,
      };
    }

    const toolResult = await deps.executeTool(result.tool);
    deps.onToolCall?.(result.tool, toolResult.ok);
    toolCalls.push({ tool: result.tool, resultSummary: toolResult.summary });

    providerHistory.push({ role: "user", content: currentMessage });
    providerHistory.push({ role: "tool", content: toolResultToProviderText(toolResult.summary), toolName: result.tool });
    currentMessage = "(continue using the tool result above)";
  }

  // Unreachable: the loop above always returns by i === maxToolCalls.
  return { response: woisUnavailableResponse(), toolCalls, usedFallback: true };
}
