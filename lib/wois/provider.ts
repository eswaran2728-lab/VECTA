import { executeWoisQuery, type UserContext, type ConversationTurn } from "./engine";
import type { WoisEngineResponse } from "@/lib/avsec/types";

/**
 * Provider-independent AI boundary for WOIS AI 2.0.
 *
 * No real LLM provider is configured or contacted in this phase (no
 * ANTHROPIC_API_KEY/OPENAI_API_KEY is set, no AI SDK package is installed --
 * confirmed by inspection before writing this file). Building "conversational
 * AI" on top of a provider that doesn't exist here would mean either
 * fabricating one or silently calling a live, billed, unauthorized endpoint,
 * both of which this phase's instructions explicitly forbid.
 *
 * Instead this is the seam: `WoisProvider` is the interface a real
 * model-backed provider would implement later (server-side only, behind a
 * validated required env var), and `RuleEngineProvider` is today's only
 * registered provider -- the existing deterministic engine, now extended
 * with bounded multi-turn history. `getWoisProvider()` is the single place
 * that decides which implementation runs, so adding a real provider later
 * never requires touching call sites.
 */
export interface WoisProviderContext {
  history: ConversationTurn[];
  userContext: UserContext;
}

export interface WoisProvider {
  readonly name: string;
  readonly model: string;
  generate(message: string, ctx: WoisProviderContext): Promise<WoisEngineResponse>;
}

class RuleEngineProvider implements WoisProvider {
  readonly name = "rule_engine";
  readonly model = "wois-rule-engine-v1";

  async generate(message: string, ctx: WoisProviderContext): Promise<WoisEngineResponse> {
    return executeWoisQuery(message, ctx.userContext, ctx.history);
  }
}

let cachedProvider: WoisProvider | null = null;

/**
 * Returns the active WOIS provider. Always the deterministic rule engine in
 * this phase -- there is no environment variable to flip here because there
 * is no second provider implemented yet, which is the honest state rather
 * than an unused feature flag.
 */
export function getWoisProvider(): WoisProvider {
  if (!cachedProvider) {
    cachedProvider = new RuleEngineProvider();
  }
  return cachedProvider;
}

/** "AI temporarily unavailable" fallback response, used when a provider call
 * throws or exceeds its timeout -- never a fabricated or guessed answer. */
export function woisUnavailableResponse(): WoisEngineResponse {
  return {
    body: "W.O.I.S AI is temporarily unavailable. Please try again in a moment, or use the normal VECTA pages for anything time-sensitive.",
    confidence_tag: "UNCERTAIN",
    source_type: "general",
    sources: [],
  };
}
