import { createAdminClient } from "@/lib/supabase/admin";
import type { RegistrationDeps } from "./registration";

/**
 * Runtime wiring for the public registration boundary.
 *
 * Anti-automation is provider independent: the handler only calls `verify(token, ip)`. The adapter below speaks Cloudflare Turnstile and
 * is active only when TURNSTILE_SECRET_KEY is configured. Verification is REQUIRED in production (VERCEL_ENV=production) or whenever
 * REGISTRATION_ANTIBOT_REQUIRED=true; if it is required and no secret exists the endpoint answers 503 instead of opening.
 * Previews and local development stay usable without a provider.
 */
export function registrationEnv(env: NodeJS.ProcessEnv = process.env): RegistrationDeps["env"] {
  return {
    antibotConfigured: Boolean(env.TURNSTILE_SECRET_KEY),
    antibotRequired: env.REGISTRATION_ANTIBOT_REQUIRED === "true" || env.VERCEL_ENV === "production",
    // client-address headers are attacker-controlled unless a trusted proxy (Vercel) sets them
    trustProxyHeaders: Boolean(env.VERCEL) || env.REGISTRATION_TRUST_PROXY === "true",
  };
}

export async function verifyTurnstile(token: string | null, ip: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

/** Durable, serverless-safe fixed-window limiter: a counter row per (hashed key, window) incremented atomically in the database. */
export function databaseThrottle(admin: ReturnType<typeof createAdminClient>): RegistrationDeps["throttle"] {
  return async (keyHash, limit, windowSeconds) => {
    const { data, error } = await (admin as unknown as { rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }).rpc("registration_throttle_hit", {
      p_key_hash: keyHash,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return "error";
    return data === true ? "ok" : "limited";
  };
}

export function registrationDeps(): RegistrationDeps {
  const admin = createAdminClient();
  return {
    admin: admin as unknown as RegistrationDeps["admin"],
    verify: (token, ip) => verifyTurnstile(token, ip),
    throttle: databaseThrottle(admin),
    env: registrationEnv(),
    log: (event, detail) => console.error(`[register] ${event}`, detail ?? ""),
  };
}
