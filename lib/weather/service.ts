import { forecastLocationFor } from "./stations";
import { forecastUrl, malaysiaDate, parseForecast, type ForecastResult } from "./forecast";

type FetchLike = (url: string, init?: { signal?: AbortSignal; next?: { revalidate: number } }) => Promise<Response>;

export interface ForecastServiceOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long a fetched forecast is reused. The upstream allows 4 requests a minute; one call per location per few hours is far below that. */
  ttlMs?: number;
  /** Minimum spacing between ANY two upstream calls from this process (20 s = at most 3 a minute). */
  minGapMs?: number;
  /** After any failure (429, timeout, bad data) the upstream is left alone for this long. */
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Cached, de-duplicated, rate-limited reader of the official forecast. Never throws: every failure is a safe "unavailable" (or last-known data marked stale). */
export function createForecastService(opts: ForecastServiceOptions = {}) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 3 * 3600_000;
  const minGapMs = opts.minGapMs ?? 20_000;
  const backoffMs = opts.backoffMs ?? 5 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const cache = new Map<string, { at: number; raw: unknown }>();
  const inflight = new Map<string, Promise<unknown | null>>();
  let lastUpstreamAt = 0;
  let backoffUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function fetchRaw(id: string, today: string): Promise<unknown | null> {
    // calls are serialised and spaced, so many locations requested together still stay under the upstream limit
    const run = async (): Promise<unknown | null> => {
      if (now() < backoffUntil) return null;
      const wait = lastUpstreamAt + minGapMs - now();
      if (lastUpstreamAt > 0 && wait > 0) await sleep(wait);
      lastUpstreamAt = now();
      try {
        const res = await fetchImpl(forecastUrl(id, today), { signal: AbortSignal.timeout(timeoutMs), next: { revalidate: Math.floor(ttlMs / 1000) } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw)) throw new Error("unexpected response shape");
        return raw;
      } catch {
        backoffUntil = now() + backoffMs;
        return null;
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async get(station: string | null | undefined): Promise<ForecastResult> {
      if (!station) return { status: "unavailable", reason: "no-station" };
      const loc = forecastLocationFor(station);
      if (!loc) return { status: "unavailable", reason: "no-mapping" };
      const today = malaysiaDate(now());

      const cached = cache.get(loc.id);
      if (cached && now() - cached.at < ttlMs) {
        const p = parseForecast(cached.raw, loc.id, today);
        if (p.status === "ok") return { ...p, fetchedAt: new Date(cached.at).toISOString() };
      }

      let pending = inflight.get(loc.id);
      if (!pending) {
        pending = fetchRaw(loc.id, today).finally(() => inflight.delete(loc.id));
        inflight.set(loc.id, pending);
      }
      const raw = await pending;
      if (raw !== null) {
        const p = parseForecast(raw, loc.id, today);
        if (p.status === "ok") {
          cache.set(loc.id, { at: now(), raw });
          return { ...p, fetchedAt: new Date(now()).toISOString() };
        }
        // the upstream answered but the data is unusable (for example no entry for today): back off, show last good data if it still covers today
        backoffUntil = now() + backoffMs;
      }
      if (cached) {
        const p = parseForecast(cached.raw, loc.id, today);
        if (p.status === "ok") return { ...p, stale: true, fetchedAt: new Date(cached.at).toISOString() };
      }
      return { status: "unavailable", reason: "upstream" };
    },
  };
}

/** Process-wide instance used by the station workspaces. */
export const forecastService = createForecastService();
