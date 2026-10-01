# WOIS AI 2.0 — Gemini provider

This document covers the real conversational provider added in Phase 12's
correction: Google Gemini, behind the existing `WoisProvider` interface
(`lib/wois/provider.ts`). It is implemented and locally tested against a
fake client — it has **not** been activated against a real Gemini key in
this environment, and must not be described as "active" until a staging
deployment has done so.

## 1. Creating a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Sign in with the Google account that should own this key.
3. Click **Create API key**, choosing (or creating) the Google Cloud
   project that will be billed/quota-tracked for WOIS AI usage.
4. Copy the key immediately — Google does not show it again in full.
5. **Store it only as an encrypted environment variable** in the hosting
   platform's secret/environment configuration (e.g. Vercel Environment
   Variables, a Supabase Edge Function secret, or equivalent) for the
   server runtime. Never put it in a repository file, a client-side env
   var, a build log, or a support ticket.

## 2. Required environment variables

All of these are read server-side only, in `lib/wois/config.ts`. None may
ever be prefixed `NEXT_PUBLIC_` — doing so would bundle the value into the
browser.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WOIS_AI_PROVIDER` | to activate Gemini | unset (→ rule engine) | Must be exactly `gemini`, lowercase, to activate. Any other value (or absence) keeps the deterministic fallback active regardless of whether a key is set. |
| `GEMINI_API_KEY` | to activate Gemini | unset | The key from step 1. |
| `GEMINI_MODEL` | no | `gemini-2.5-flash` | Deployment-configurable — never hardcode a model name you expect to change later. |
| `WOIS_AI_TIMEOUT_MS` | no | `8000` | Clamped to [1000, 30000]. |
| `WOIS_AI_MAX_OUTPUT_TOKENS` | no | `1024` | Clamped to [128, 4096]. |
| `WOIS_AI_MAX_TOOL_CALLS` | no | `3` | Clamped to [0, 5]. Bounds the tool-call loop per user turn. |
| `WOIS_AI_MAX_HISTORY_MESSAGES` | no | `20` | Clamped to [0, 50]. Bounds how much prior conversation is sent per request. |

Gemini is selected **only** when both `WOIS_AI_PROVIDER=gemini` and
`GEMINI_API_KEY` are set and non-empty (`lib/wois/config.ts:getWoisAiConfig`).
Every other combination — missing key, wrong provider value, empty string —
resolves to the deterministic rule engine, with no error surfaced to the
user.

## 3. Fallback behavior

The orchestrator (`lib/wois/orchestrator.ts`) wraps every provider call in
a bounded timeout and a try/catch. Any of the following falls back to the
deterministic rule engine's answer for that turn, and the chat API marks
the response with `usedFallback: true` (and, in the audit log, a
`provider_failure` event naming the provider that failed — never raw
provider error text):

- Gemini is not configured at all (`WOIS_AI_PROVIDER` unset or wrong value).
- The request times out (`WOIS_AI_TIMEOUT_MS`).
- Gemini returns a response with neither text nor a function call.
- Gemini throws (network error, auth error, quota/rate-limit error — the
  SDK surfaces these as thrown errors from `generateContent`, which the
  orchestrator catches generically; no raw provider error message is ever
  returned to the browser).

The conversation and its persisted messages record `provider`/`model` per
message (not just per conversation), since a single conversation can span
a Gemini turn followed by a fallback turn.

## 4. Quota / rate-limit handling

This phase does not implement provider-side retry or backoff — a
rate-limited or quota-exhausted call is treated exactly like any other
provider failure (see §3): it falls back to the rule engine for that turn.
A production deployment that needs retry/backoff or usage-based alerting
should add it inside `GeminiProvider.generate()` without changing the
`WoisProvider` interface or any caller.

## 5. Staging activation steps

1. Create a Gemini API key (§1) under a project with billing/quota
   appropriate for expected WOIS AI traffic.
2. Set `WOIS_AI_PROVIDER=gemini` and `GEMINI_API_KEY=<the key>` in the
   staging environment's encrypted environment configuration.
3. Optionally set `GEMINI_MODEL` and the `WOIS_AI_*` bounds for that
   environment.
4. Deploy, then exercise WOIS AI as a real approved Malaysia AOC staff
   account in staging and confirm: a real conversational answer, a tool
   call completing correctly, and a deliberately short
   `WOIS_AI_TIMEOUT_MS` test to confirm fallback still engages cleanly.
5. Only after that verification should Gemini be described as "active" in
   any report or documentation.

## 6. Disabling Gemini immediately

Set `WOIS_AI_PROVIDER` to anything other than `gemini` (or unset it) and
redeploy/restart the server process. `lib/wois/provider.ts` caches the
selected provider per process (`getWoisProvider()`), so an environment
variable change takes effect on the next process start — no code change,
migration, or data change is required. There is no separate "kill switch"
RPC or flag, because this single environment variable already is one.

## 7. What Gemini can and cannot do

Gemini (like the rule engine) can only:

- Answer from its own knowledge or from a tool result handed to it.
- Ask a clarifying question (reply beginning `CLARIFY:`).
- Request exactly one of the named tools in `lib/wois/tools.ts`'s
  `WOIS_TOOL_SPECS` — no arguments, no table/RPC/SQL construction, no
  other tool name. The orchestrator independently re-validates any
  requested tool name against the same closed allowlist before executing
  anything, so even a compromised or hallucinating model cannot reach
  outside it.

Gemini can never approve, reject, publish, modify, upload, delete, export,
or otherwise execute any write action — there is no write-capable tool in
the allowlist for it to call, by design.

## 8. Privacy / what is never sent to Gemini

See `lib/wois/redaction.ts` for the enforced minimization layer. Before
anything reaches `GeminiProvider.generate()`, free text (user input and
tool summaries) is passed through `redactSecrets()`, which strips
API-key-, bearer-token-, JWT-, signed-URL-, and SSN-shaped substrings. Tool
results are also minimized at the source in `lib/wois/tools.ts` — every
tool returns a short summary string and a small, already-field-limited
`data` object, never a raw database row, a full report body, a signed
storage URL, or an unrestricted staff list.
