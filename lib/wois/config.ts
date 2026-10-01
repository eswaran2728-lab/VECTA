/**
 * Phase 12 WOIS AI 2.0 runtime configuration -- server-only env parsing.
 *
 * Every value here is read from `process.env`, which is never bundled into
 * client code by Next.js unless explicitly prefixed `NEXT_PUBLIC_` (none of
 * these are). This module must never be imported from a "use client"
 * component; see tests/wois-phase12-provider-boundary.test.mts for the
 * build-level check that it never ends up in the client bundle.
 */

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface WoisAiConfig {
  provider: "gemini" | "rule_engine";
  geminiApiKey: string | undefined;
  geminiModel: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxHistoryMessages: number;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Reads and validates WOIS AI configuration from the environment. Returns
 * `provider: "rule_engine"` whenever Gemini isn't fully configured, which
 * is the ONLY way this module ever selects a real provider -- there is no
 * other code path that flips this on.
 */
export function getWoisAiConfig(): WoisAiConfig {
  const requestedProvider = (process.env.WOIS_AI_PROVIDER ?? "").trim().toLowerCase();
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || undefined;
  const geminiModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const provider: WoisAiConfig["provider"] = requestedProvider === "gemini" && Boolean(geminiApiKey) ? "gemini" : "rule_engine";

  return {
    provider,
    geminiApiKey,
    geminiModel,
    timeoutMs: parseBoundedInt(process.env.WOIS_AI_TIMEOUT_MS, 8000, 1000, 30000),
    maxOutputTokens: parseBoundedInt(process.env.WOIS_AI_MAX_OUTPUT_TOKENS, 1024, 128, 4096),
    maxToolCalls: parseBoundedInt(process.env.WOIS_AI_MAX_TOOL_CALLS, 3, 0, 5),
    maxHistoryMessages: parseBoundedInt(process.env.WOIS_AI_MAX_HISTORY_MESSAGES, 20, 0, 50),
  };
}
