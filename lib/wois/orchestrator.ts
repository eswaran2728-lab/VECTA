import type { WoisProvider, WoisProviderTurn } from "./provider";
import { woisUnavailableResponse } from "./provider";
import { WOIS_TOOL_SPECS, isKnownWoisTool, type WoisToolName } from "./tools";
import { toolResultToProviderText } from "./redaction";
import { validateProviderFinal } from "./output-validation";
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
  /** Deterministic provider used when `provider` times out, errors or returns invalid output. Optional: without it the safe
   * "temporarily unavailable" message is returned instead. */
  fallbackProvider?: WoisProvider;
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

export type WoisFallbackReason = "timeout" | "provider_error" | "invalid_output" | "provider_rejected" | "provider_auth" | "provider_model_unavailable" | "provider_rate_limited" | "provider_unavailable" | "provider_precondition";

/** Reduces a provider error to a safe category from its numeric HTTP status ONLY -- the error text is never read, stored or returned. */
function classifyProviderError(e: unknown): WoisFallbackReason {
  if (e instanceof Error && e.message === "provider_timeout") return "timeout";
  const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
  if (typeof status !== "number") return "provider_error";
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 404) return "provider_model_unavailable";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status === 400) {
    // Only well-known Google status tokens are matched; the message text is never stored or returned.
    const text = e instanceof Error ? e.message : "";
    if (text.includes("API_KEY_INVALID") || text.includes("API key not valid")) return "provider_auth";
    if (text.includes("FAILED_PRECONDITION")) return "provider_precondition";
  }
  if (status >= 400) return "provider_rejected";
  return "provider_error";
}

export interface WoisOrchestratorResult {
  response: WoisEngineResponse;
  toolCalls: WoisToolCall[];
  /** True if the deterministic fallback engine answered instead of the
   * requested provider (timeout, error, invalid response, or the provider
   * was never configured in the first place). */
  usedFallback: boolean;
  /** Why the primary provider was not used. A category only -- never raw provider error text. */
  fallbackReason?: WoisFallbackReason;
}

export const FALLBACK_NOTICE = "This answer comes from the built-in W.O.I.S assistant because the AI service was unavailable. It may be less conversational.";

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

type LoopOutcome = { ok: true; response: WoisEngineResponse; toolCalls: WoisToolCall[] } | { ok: false; reason: WoisFallbackReason; toolCalls: WoisToolCall[] };

async function runLoop(provider: WoisProvider, message: string, deps: WoisOrchestratorDeps, validate: boolean): Promise<LoopOutcome> {
  const toolCalls: WoisToolCall[] = [];
  const providerHistory: WoisProviderTurn[] = deps.history.map((t) => ({ role: t.role, content: t.content }));
  let currentMessage = message;
  const maxToolCalls = Math.max(0, deps.maxToolCalls);

  for (let i = 0; i <= maxToolCalls; i++) {
    let result;
    try {
      result = await withTimeout(
        provider.generate(currentMessage, {
          history: providerHistory,
          userContext: deps.userContext,
          availableTools: WOIS_TOOL_SPECS,
          signal: deps.signal,
        }),
        deps.timeoutMs
      );
    } catch (e) {
      return { ok: false, reason: classifyProviderError(e), toolCalls };
    }

    if (result.type === "final") {
      if (validate && !validateProviderFinal(result.response).ok) return { ok: false, reason: "invalid_output", toolCalls };
      return { ok: true, response: { ...result.response, toolCalls }, toolCalls };
    }

    if (result.type === "clarify") {
      return {
        ok: true,
        response: { body: result.question, confidence_tag: "UNCERTAIN", source_type: "general", sources: [], toolCalls },
        toolCalls,
      };
    }

    // result.type === "tool_call" -- independently re-validate against the
    // closed allowlist. A provider asking for anything else is rejected
    // outright, not silently ignored or substituted.
    if (!isKnownWoisTool(result.tool)) {
      deps.onToolCall?.(result.tool, false);
      return {
        ok: true,
        response: {
          body: "I can't do that from here, but I can tell you about your own reports, notifications, announcements, roster, overtime, or role assignments.",
          confidence_tag: "UNCERTAIN",
          source_type: "general",
          sources: [],
          toolCalls,
        },
        toolCalls,
      };
    }

    if (i === maxToolCalls) {
      // Tool-call limit reached -- stop the loop deterministically rather
      // than ever looping indefinitely.
      return {
        ok: true,
        response: {
          body: "I've gathered what I can from your account for this turn. Ask me to continue if you need more.",
          confidence_tag: "UNCERTAIN",
          source_type: "general",
          sources: [],
          toolCalls,
        },
        toolCalls,
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
  return { ok: false, reason: "provider_error", toolCalls };
}

export async function runWoisOrchestrator(message: string, deps: WoisOrchestratorDeps): Promise<WoisOrchestratorResult> {
  // The deterministic engine's own answers are static content and are not re-validated as model output.
  const primary = await runLoop(deps.provider, message, deps, deps.provider.name !== "rule_engine");
  if (primary.ok) return { response: primary.response, toolCalls: primary.toolCalls, usedFallback: false };

  if (deps.fallbackProvider) {
    const fb = await runLoop(deps.fallbackProvider, message, deps, false);
    if (fb.ok) {
      return {
        response: { ...fb.response, fallbackNotice: FALLBACK_NOTICE },
        toolCalls: fb.toolCalls,
        usedFallback: true,
        fallbackReason: primary.reason,
      };
    }
  }
  return { response: woisUnavailableResponse(), toolCalls: primary.toolCalls, usedFallback: true, fallbackReason: primary.reason };
}
