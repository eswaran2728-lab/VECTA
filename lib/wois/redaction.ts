/**
 * Phase 12 WOIS AI 2.0 context-redaction/minimization layer.
 *
 * Tool results already come back minimized (lib/wois/tools.ts returns a
 * short `summary` string plus small, display-safe `data`, never a raw RPC
 * row set). This module is the second, independent layer that runs
 * immediately before anything is sent to a real model provider (Gemini),
 * so a future tool that forgets to minimize its own output still cannot
 * leak a credential-shaped or otherwise sensitive value into a prompt.
 *
 * It also runs on free-text user input before it joins conversation
 * history, since a user could paste a token, password, or signed URL into
 * the chat box themselves.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9]{10,}\b/g, // OpenAI/Anthropic-style keys
  /\bAIza[0-9A-Za-z\-_]{10,}\b/g, // Google API key shape
  /\bBearer\s+[a-zA-Z0-9._\-]{10,}\b/gi,
  /\beyJ[a-zA-Z0-9._\-]{10,}\b/g, // JWT-shaped tokens
  /https?:\/\/[^\s]+[?&](token|signature|sig|expires|x-amz-signature)=[^\s]+/gi, // signed URLs
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN-shaped
];

/** Redacts anything secret-/token-/signed-URL-shaped from free text. Safe
 * to run on user input, tool summaries, or provider output alike. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

const MAX_FIELD_LENGTH = 500;

/**
 * Minimizes a tool result's `data` payload before it is turned into text
 * for a model: truncates long strings, drops any key that looks like a
 * credential/URL/identifier field, and bounds array length. This is
 * intentionally conservative -- it is a safety net, not the primary
 * authorization or minimization mechanism (that lives in the RPCs and in
 * each tool wrapper's own field selection).
 */
const SENSITIVE_KEY_PATTERN = /token|secret|password|key|signed|signature|credential/i;

export function minimizeToolData(data: unknown, depth = 0): unknown {
  if (depth > 3) return "[omitted]";
  if (data === null || data === undefined) return data;
  if (typeof data === "string") {
    const redacted = redactSecrets(data);
    return redacted.length > MAX_FIELD_LENGTH ? redacted.slice(0, MAX_FIELD_LENGTH) + "…" : redacted;
  }
  if (typeof data === "number" || typeof data === "boolean") return data;
  if (Array.isArray(data)) {
    return data.slice(0, 20).map((item) => minimizeToolData(item, depth + 1));
  }
  if (typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      out[key] = minimizeToolData(value, depth + 1);
    }
    return out;
  }
  return "[omitted]";
}

/** Renders a tool result into the short, redacted text handed to a
 * provider as a "tool" turn -- the summary only, never the structured
 * `data` field (that stays server-side for the UI to render, already
 * minimized by minimizeToolData when persisted). */
export function toolResultToProviderText(summary: string): string {
  return redactSecrets(summary).slice(0, MAX_FIELD_LENGTH);
}
