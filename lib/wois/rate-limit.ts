import { getWoisAiConfig } from "./config";

/**
 * Server-side sliding-window rate limiter for WOIS chat requests, keyed by the authenticated user id (never by anything the client sends).
 * State is held in process memory: it bounds abuse per server instance and protects the Gemini quota, but it is not a global limit across
 * serverless instances -- a distributed limit would need shared storage and is a separate decision. Memory is bounded (maxKeys), and refused
 * calls are not recorded, so hammering while blocked cannot extend the block.
 */
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  size(): number;
}

export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 5000 }: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();

  const prune = (timestamps: number[], t: number) => {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < timestamps.length && timestamps[i] <= cutoff) i++;
    if (i > 0) timestamps.splice(0, i);
  };

  return {
    check(key) {
      const t = now();
      const timestamps = hits.get(key) ?? [];
      prune(timestamps, t);
      if (timestamps.length >= limit) {
        hits.delete(key);
        hits.set(key, timestamps); // keep recently-seen keys at the end for eviction order
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((timestamps[0] + windowMs - t) / 1000)) };
      }
      timestamps.push(t);
      hits.delete(key);
      hits.set(key, timestamps);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    size: () => hits.size,
  };
}

let shared: RateLimiter | null = null;

/** The limiter the chat route uses, configured from WOIS_AI_RATE_LIMIT_MAX / WOIS_AI_RATE_LIMIT_WINDOW_MS (bounded in lib/wois/config.ts). */
export function getWoisRateLimiter(): RateLimiter {
  if (!shared) {
    const config = getWoisAiConfig();
    shared = createRateLimiter({ limit: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
  }
  return shared;
}

/** Test-only reset so tests can change the environment between cases. Never called from application code. */
export function _resetWoisRateLimiterForTests(): void {
  shared = null;
}
