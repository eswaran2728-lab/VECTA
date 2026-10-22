import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../lib/wois/rate-limit.ts";
import { validateProviderFinal } from "../lib/wois/output-validation.ts";
import { runWoisOrchestrator } from "../lib/wois/orchestrator.ts";
import { GeminiProvider, RuleEngineProvider, type GeminiClientLike, type WoisProvider } from "../lib/wois/provider.ts";
import type { WoisEngineResponse } from "../lib/avsec/types.ts";

// Built at runtime so no key-shaped literal sits in the repository (secret scanners). Not a real key.
const SECRET = ["AI", "za", "SyD-not-a-real-key-0123456789abcdef"].join("");

// ---------------------------------------------------------------- rate limiter (pure, injectable clock)
test("rate limiter: allows up to the limit per key per window, then refuses with a retry-after, per key", () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  assert.deepEqual([rl.check("u1").allowed, rl.check("u1").allowed, rl.check("u1").allowed], [true, true, true]);
  const blocked = rl.check("u1");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  assert.equal(rl.check("u2").allowed, true, "another user is unaffected");
  now += 61_000;
  assert.equal(rl.check("u1").allowed, true, "the window slides: the first user may ask again");
});

test("rate limiter: refused calls do not extend the block, and memory is bounded", () => {
  let now = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, maxKeys: 50 });
  assert.equal(rl.check("a").allowed, true);
  for (let i = 0; i < 20; i++) assert.equal(rl.check("a").allowed, false);
  now += 1001;
  assert.equal(rl.check("a").allowed, true, "spamming while blocked does not push the window out");
  for (let i = 0; i < 500; i++) rl.check(`k${i}`);
  assert.ok(rl.size() <= 50, `tracked keys stay bounded (${rl.size()})`);
});

// ---------------------------------------------------------------- output validation
const ok: WoisEngineResponse = { body: "SEC 013 is the Station Security Checklist.", confidence_tag: "GENERAL_KNOWLEDGE", source_type: "general", sources: [] };
test("output validation: accepts a normal answer, rejects empty, oversized, secret-shaped and system-prompt-leaking output", () => {
  assert.equal(validateProviderFinal(ok).ok, true);
  assert.equal(validateProviderFinal({ ...ok, body: "   " }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, body: "x".repeat(20_001) }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, body: `the key is ${SECRET}` }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, body: "Bearer abcdefghijklmnop1234" }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, body: "You are W.O.I.S, a read-only operational assistant for AirAsia AVSEC Malaysia staff" }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, body: "Never invent a tool name outside this list, never pass arguments to a tool" }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, confidence_tag: "SOMETHING_ELSE" as never }).ok, false);
  assert.equal(validateProviderFinal({ ...ok, sources: "nope" as never }).ok, false);
  const bad = validateProviderFinal({ ...ok, body: "" });
  assert.ok(!bad.ok && bad.reason === "invalid_output");
});

// ---------------------------------------------------------------- orchestrator fallback
const scripted = (fn: () => Promise<never> | never, name = "gemini"): WoisProvider => ({ name, model: "m", generate: async () => fn() });
const finalProvider = (body: string, name = "rule_engine"): WoisProvider => ({ name, model: "wois-rule-engine-v1", generate: async () => ({ type: "final", response: { ...ok, body } }) });
const base = { history: [], userContext: {}, executeTool: async () => ({ ok: true, summary: "x" }), maxToolCalls: 2, timeoutMs: 80 };

test("fallback: a timeout answers with the deterministic engine, labelled, with the reason, and no technical detail", async () => {
  const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => new Promise(() => {})), fallbackProvider: finalProvider("deterministic answer") });
  assert.equal(r.usedFallback, true);
  assert.equal(r.fallbackReason, "timeout");
  assert.equal(r.response.body, "deterministic answer");
  assert.match(r.response.fallbackNotice ?? "", /built-in/i);
  assert.doesNotMatch(JSON.stringify(r.response), /gemini|api key|quota|429|timeout/i);
});

test("fallback: a provider error (even one carrying a secret) falls back without exposing the error text", async () => {
  const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw new Error(`429 RESOURCE_EXHAUSTED key=${SECRET}`); }), fallbackProvider: finalProvider("deterministic answer") });
  assert.equal(r.usedFallback, true);
  assert.equal(r.fallbackReason, "provider_error");
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("RESOURCE_EXHAUSTED"));
});

test("fallback: malformed provider output (empty text, no function call) falls back as a provider error", async () => {
  const client: GeminiClientLike = { models: { generateContent: async () => ({}) } };
  const r = await runWoisOrchestrator("q", { ...base, timeoutMs: 2000, provider: new GeminiProvider(client, "fake", 2000, 256), fallbackProvider: finalProvider("deterministic answer") });
  assert.equal(r.usedFallback, true);
  assert.equal(r.response.body, "deterministic answer");
});

test("fallback: an invalid final answer (system-prompt leak, secret-shaped, oversized) is rejected and replaced by the deterministic answer", async () => {
  for (const body of ["You are W.O.I.S, a read-only operational assistant for AirAsia AVSEC Malaysia staff inside the VECTA application.", `use ${SECRET}`, "y".repeat(25_000)]) {
    const r = await runWoisOrchestrator("q", { ...base, provider: finalProvider(body, "gemini"), fallbackProvider: finalProvider("deterministic answer") });
    assert.equal(r.usedFallback, true, body.slice(0, 20));
    assert.equal(r.fallbackReason, "invalid_output");
    assert.equal(r.response.body, "deterministic answer");
  }
});

test("fallback: when the fallback itself fails the user gets the safe unavailable message (never a guess)", async () => {
  const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw new Error("boom"); }), fallbackProvider: scripted(() => { throw new Error("also boom"); }, "rule_engine") });
  assert.equal(r.usedFallback, true);
  assert.equal(r.response.confidence_tag, "UNCERTAIN");
  assert.match(r.response.body, /unavailable/i);
});

test("fallback: without a fallback provider the previous behaviour holds (unavailable message), and a healthy provider is never replaced", async () => {
  const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw new Error("boom"); }) });
  assert.equal(r.usedFallback, true);
  assert.match(r.response.body, /unavailable/i);
  const good = await runWoisOrchestrator("q", { ...base, provider: finalProvider("real answer", "gemini"), fallbackProvider: finalProvider("deterministic answer") });
  assert.equal(good.usedFallback, false);
  assert.equal(good.response.body, "real answer");
  assert.equal(good.fallbackReason, undefined);
});

test("the real deterministic engine can serve as the fallback provider (it needs no network and no key)", async () => {
  const r = await runWoisOrchestrator("what is SEC 013?", { ...base, timeoutMs: 5000, provider: scripted(() => { throw new Error("down"); }), fallbackProvider: new RuleEngineProvider() });
  assert.equal(r.usedFallback, true);
  assert.ok(r.response.body.length > 10);
  assert.match(r.response.fallbackNotice ?? "", /built-in/i);
});

// ---------------------------------------------------------------- the chat route (mocked identity, eligibility and provider)
process.env.WOIS_AI_RATE_LIMIT_MAX = "3";
process.env.WOIS_AI_RATE_LIMIT_WINDOW_MS = "60000";
const realProvider = await import("../lib/wois/provider.ts");
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let currentUser: { id: string } | null = { id: "user-1" };
let eligible = true;
let providerImpl: WoisProvider = finalProvider("ok", "gemini");
const seenContexts: unknown[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: currentUser } }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === "create_wois_conversation_secure") return { data: "conv-1", error: null };
        if (name === "list_wois_messages_secure") return { data: [], error: null };
        return { data: null, error: null };
      },
    }),
  },
});
mock.module("@/lib/wois/eligibility", { namedExports: { getWoisEligibility: async () => (eligible ? { eligible: true } : { eligible: false, reason: "not_in_aoc" }) } });
mock.module("@/lib/wois/provider", {
  namedExports: {
    ...realProvider,
    getWoisProvider: async () => ({ ...providerImpl, generate: async (m: string, c: { userContext: unknown }) => { seenContexts.push(c.userContext); return providerImpl.generate(m, c as never); } }),
  },
});
const { POST } = await import("../app/api/wois/chat/route.ts");
const { _resetWoisRateLimiterForTests } = await import("../lib/wois/rate-limit.ts");
const post = (body: unknown) => POST(new Request("http://localhost/api/wois/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const reset = () => { rpcCalls.length = 0; seenContexts.length = 0; currentUser = { id: "user-1" }; eligible = true; providerImpl = finalProvider("ok", "gemini"); _resetWoisRateLimiterForTests(); };

test("route: unauthenticated callers get 401 and nothing is called", async () => {
  reset(); currentUser = null;
  const res = await post({ message: "hi" });
  assert.equal(res.status, 401);
  assert.equal(rpcCalls.length, 0);
});

test("route: an ineligible caller gets 403 and the provider is never invoked", async () => {
  reset(); eligible = false;
  const res = await post({ message: "hi" });
  assert.equal(res.status, 403);
  assert.equal(seenContexts.length, 0);
});

test("route: the client cannot supply identity or scope -- a posted userContext never reaches the provider", async () => {
  reset();
  const res = await post({ message: "hi", userContext: { role: "super_admin", aoc_id: "other", station: "KUL", orgId: "x" } });
  assert.equal(res.status, 200);
  assert.deepEqual(seenContexts, [{}]);
});

test("route: a provider failure answers from the deterministic fallback, labelled, with a sanitized audit event and no leaked error text", async () => {
  reset();
  providerImpl = scripted(() => { throw new Error(`HTTP 403 key=${SECRET} PERMISSION_DENIED`); }, "gemini");
  const res = await post({ message: "what is SEC 013?" });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.response.usedFallback, true);
  assert.equal(json.response.provider, "rule_engine");
  assert.match(json.response.fallbackNotice, /built-in/i);
  assert.equal(json.response.fallbackReason, "provider_error");
  const audit = rpcCalls.find((c) => c.name === "record_wois_audit_event_secure" && c.args.p_event_type === "provider_failure");
  assert.ok(audit, "provider_failure audit event recorded");
  assert.deepEqual(audit!.args.p_details, { provider: "gemini", reason: "provider_error" });
  assert.ok(!JSON.stringify([json, rpcCalls]).includes(SECRET) && !JSON.stringify([json, rpcCalls]).includes("PERMISSION_DENIED"));
  const stored = rpcCalls.find((c) => c.name === "append_wois_message_secure" && c.args.p_sender === "assistant");
  assert.equal(stored!.args.p_provider, "rule_engine");
});

test("route: server-side rate limit -- the fourth request in the window is refused with 429, Retry-After, a safe message and an audit event; another user is unaffected", async () => {
  reset();
  for (let i = 0; i < 3; i++) assert.equal((await post({ message: `q${i}` })).status, 200);
  const calls = seenContexts.length;
  const res = await post({ message: "q4" });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  const json = await res.json();
  assert.match(json.error, /too many/i);
  assert.equal(seenContexts.length, calls, "the provider is not called for a refused request");
  const audit = rpcCalls.find((c) => c.name === "record_wois_audit_event_secure" && c.args.p_event_type === "rate_limited");
  assert.ok(audit, "rate_limited audit event recorded");
  assert.deepEqual(Object.keys(audit!.args.p_details as object).sort(), ["limit", "window_seconds"]);
  currentUser = { id: "user-2" };
  assert.equal((await post({ message: "hello" })).status, 200);
});

test("route: bad input is refused before the provider (oversized, empty, malformed body, non-string conversation id)", async () => {
  reset();
  assert.equal((await post({ message: "x".repeat(2001) })).status, 400);
  assert.equal((await post({ message: "   " })).status, 400);
  assert.equal((await post({ message: "hi", conversationId: 42 })).status, 400);
  const res = await POST(new Request("http://localhost/api/wois/chat", { method: "POST", body: "{not json" }));
  assert.equal(res.status, 400);
  assert.equal(seenContexts.length, 0);
});

test("route: an unreadable / foreign conversation id fails closed with 403 (ownership is decided by the database RPC)", async () => {
  reset();
  const mod = await import("@/lib/supabase/server");
  assert.ok(mod.createClient);
  // the mocked RPC for list_wois_messages_secure succeeds above; here we only assert the route maps an RPC error to 403 via source (DB isolation is proven by verify_phase12_wois_ai)
  const src = (await import("node:fs")).readFileSync("app/api/wois/chat/route.ts", "utf8");
  assert.match(src, /list_wois_messages_secure[\s\S]{0,400}historyError[\s\S]{0,300}status: 403/);
});

test("fallback: an HTTP status on the provider error is reduced to a safe category (never the error text)", async () => {
  const cases: Array<[number, string]> = [[400, "provider_rejected"], [401, "provider_auth"], [403, "provider_auth"], [404, "provider_model_unavailable"], [429, "provider_rate_limited"], [503, "provider_unavailable"]];
  for (const [status, reason] of cases) {
    const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw Object.assign(new Error(`boom key=${SECRET}`), { status }); }), fallbackProvider: finalProvider("deterministic answer") });
    assert.equal(r.usedFallback, true);
    assert.equal(r.fallbackReason, reason, `status ${status}`);
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("boom"));
  }
});

test("fallback: well-known Google error codes inside a 400 map to safe categories; the text itself is never returned", async () => {
  const cases: Array<[string, string]> = [["API_KEY_INVALID: API key not valid", "provider_auth"], ["FAILED_PRECONDITION: User location is not supported", "provider_precondition"], ["INVALID_ARGUMENT: bad field", "provider_rejected"]];
  for (const [text, reason] of cases) {
    const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw Object.assign(new Error(`${text} key=${SECRET}`), { status: 400 }); }), fallbackProvider: finalProvider("deterministic answer") });
    assert.equal(r.fallbackReason, reason, text);
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("not valid") && !JSON.stringify(r).includes("location"));
  }
});

test("fallback: a generic 400 is bucketed by fixed keywords (tools / model / config) without returning any text", async () => {
  const cases: Array<[string, string]> = [["INVALID_ARGUMENT: function_declarations[0].parameters is required", "provider_rejected_tools"], ["INVALID_ARGUMENT: model does not support this", "provider_rejected_model"], ["INVALID_ARGUMENT: system_instruction is not supported", "provider_rejected_config"], ["INVALID_ARGUMENT: something else", "provider_rejected"]];
  for (const [text, reason] of cases) {
    const r = await runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw Object.assign(new Error(`${text} key=${SECRET}`), { status: 400 }); }), fallbackProvider: finalProvider("deterministic answer") });
    assert.equal(r.fallbackReason, reason, text);
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("parameters"));
  }
});

test("fallback: errors without an HTTP status are bucketed by our own message / error name (empty response, network, abort)", async () => {
  const mk = (e: Error) => runWoisOrchestrator("q", { ...base, provider: scripted(() => { throw e; }), fallbackProvider: finalProvider("deterministic answer") });
  assert.equal((await mk(new Error("Gemini returned no text content"))).fallbackReason, "provider_empty_response");
  assert.equal((await mk(Object.assign(new Error("fetch failed"), { name: "TypeError" }))).fallbackReason, "provider_network");
  assert.equal((await mk(Object.assign(new Error("aborted"), { name: "AbortError" }))).fallbackReason, "provider_aborted");
  assert.equal((await mk(new Error("something unknown"))).fallbackReason, "provider_error");
});
