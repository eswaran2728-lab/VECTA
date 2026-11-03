/**
 * Hourly forecast from WeatherAPI.com (https://www.weatherapi.com), read ONLY on the server with a Preview/server secret (WEATHERAPI_API_KEY). It is a model
 * forecast for the airport's coordinates: not an observation of current conditions and not aviation weather. The MET Malaysia daily forecast
 * (lib/weather/forecast.ts) is a separate source and is never merged with this one. The key is never logged, returned or placed in an error.
 */
export const HOURLY_ATTRIBUTION = "Hourly forecast: WeatherAPI.com. Forecast only, not live observations and not aviation weather clearance.";

/** Airport coordinates of the VECTA stations (reference positions for the point forecast). */
export const STATION_COORDINATES: Record<string, { lat: number; lng: number }> = {
  "KUL - MAA": { lat: 2.7456, lng: 101.7099 },
  "KUL - AAX": { lat: 2.7456, lng: 101.7099 },
  AOR: { lat: 6.1897, lng: 100.3983 },
  BKI: { lat: 5.9372, lng: 116.051 },
  BTU: { lat: 3.1238, lng: 113.02 },
  JHB: { lat: 1.6413, lng: 103.6697 },
  KBR: { lat: 6.1669, lng: 102.2937 },
  KCH: { lat: 1.4847, lng: 110.3414 },
  LBU: { lat: 5.3009, lng: 115.2501 },
  LGK: { lat: 6.3297, lng: 99.7287 },
  MYY: { lat: 4.322, lng: 113.9868 },
  PEN: { lat: 5.2971, lng: 100.277 },
  SBW: { lat: 2.2616, lng: 111.985 },
  SDK: { lat: 5.9009, lng: 118.0595 },
  TGG: { lat: 5.3826, lng: 103.103 },
  TWU: { lat: 4.3135, lng: 118.122 },
  KUA: { lat: 3.7753, lng: 103.2094 },
  IPH: { lat: 4.568, lng: 101.092 },
  MKZ: { lat: 2.2634, lng: 102.2516 },
  SZB: { lat: 3.1306, lng: 101.549 },
};

export function weatherApiUrl(station: string, apiKey: string): string | null {
  const c = Object.prototype.hasOwnProperty.call(STATION_COORDINATES, station) ? STATION_COORDINATES[station] : null;
  if (!c) return null;
  const u = new URL("https://api.weatherapi.com/v1/forecast.json");
  u.searchParams.set("key", apiKey);
  u.searchParams.set("q", `${c.lat},${c.lng}`);
  u.searchParams.set("days", "2");
  u.searchParams.set("aqi", "no");
  u.searchParams.set("alerts", "no");
  return u.toString();
}

export type ConditionIcon = "sun" | "moon" | "cloud-sun" | "cloud-moon" | "cloud" | "fog" | "rain" | "thunder";

const RAIN = new Set([1063, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1240, 1243, 1246, 1072, 1069, 1204, 1207, 1249, 1252]);
const THUNDER = new Set([1087, 1273, 1276, 1279, 1282]);
const FOG = new Set([1030, 1135, 1147]);

export function conditionIcon(code: number, isDay: boolean): ConditionIcon {
  if (THUNDER.has(code)) return "thunder";
  if (RAIN.has(code)) return "rain";
  if (FOG.has(code)) return "fog";
  if (code === 1000) return isDay ? "sun" : "moon";
  if (code === 1003) return isDay ? "cloud-sun" : "cloud-moon";
  return "cloud";
}

export interface HourlyItem {
  epochMs: number;
  /** Malaysia local clock label, e.g. "2 PM". */
  label: string;
  tempC: number;
  condition: string;
  icon: ConditionIcon;
  /** Chance of rain in percent; null when the provider did not give one. */
  rainChance: number | null;
  isNow: boolean;
}

export type HourlyResult =
  | { status: "ok"; hours: HourlyItem[]; stale?: boolean; fetchedAt?: string }
  | { status: "unavailable"; reason: "no-station" | "no-mapping" | "not-configured" | "upstream" | "no-data" };

const HOUR_MS = 3_600_000;

function labelOf(epochMs: number): string {
  const h = new Date(epochMs + 8 * HOUR_MS).getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? "AM" : "PM"}`;
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The current hour and the following 23 hours of the provider's own data. Hours with a missing time, temperature or condition are skipped; nothing is invented. */
export function parseHourly(raw: unknown, nowMs: number): HourlyResult {
  const days = (raw as { forecast?: { forecastday?: unknown } } | null | undefined)?.forecast?.forecastday;
  if (!Array.isArray(days)) return { status: "unavailable", reason: "no-data" };
  const items: HourlyItem[] = [];
  for (const d of days) {
    const hours = (d as { hour?: unknown } | null)?.hour;
    if (!Array.isArray(hours)) continue;
    for (const h of hours) {
      if (!h || typeof h !== "object") continue;
      const r = h as Record<string, unknown>;
      const epoch = asNumber(r.time_epoch);
      const temp = asNumber(r.temp_c);
      const cond = r.condition as { text?: unknown; code?: unknown } | null | undefined;
      if (epoch === null || temp === null || !cond || typeof cond.text !== "string" || !cond.text) continue;
      const epochMs = epoch * 1000;
      if (epochMs + HOUR_MS <= nowMs) continue;
      const code = asNumber(cond.code) ?? 0;
      items.push({
        epochMs,
        label: labelOf(epochMs),
        tempC: Math.round(temp),
        condition: cond.text,
        icon: conditionIcon(code, asNumber(r.is_day) === 1),
        rainChance: asNumber(r.chance_of_rain),
        isNow: epochMs <= nowMs && nowMs < epochMs + HOUR_MS,
      });
    }
  }
  items.sort((a, b) => a.epochMs - b.epochMs);
  const hours = items.slice(0, 24);
  if (hours.length === 0 || hours[0].epochMs > nowMs + HOUR_MS) return { status: "unavailable", reason: "no-data" };
  return { status: "ok", hours };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; next?: { revalidate: number } }) => Promise<Response>;

export interface HourlyServiceOptions {
  apiKey?: () => string | undefined;
  fetchImpl?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

/** Cached, de-duplicated reader. Never throws and never exposes the key. */
export function createHourlyService(opts: HourlyServiceOptions = {}) {
  const apiKey = opts.apiKey ?? (() => process.env.WEATHERAPI_API_KEY);
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 30 * 60_000;
  const backoffMs = opts.backoffMs ?? 5 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const cache = new Map<string, { at: number; raw: unknown }>();
  const inflight = new Map<string, Promise<unknown | null>>();
  let backoffUntil = 0;

  const coordKey = (station: string) => {
    const c = STATION_COORDINATES[station];
    return `${c.lat},${c.lng}`;
  };

  async function fetchRaw(url: string): Promise<unknown | null> {
    if (now() < backoffUntil) return null;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), next: { revalidate: Math.floor(ttlMs / 1000) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      backoffUntil = now() + backoffMs;
      return null;
    }
  }

  return {
    async get(station: string | null | undefined): Promise<HourlyResult> {
      if (!station) return { status: "unavailable", reason: "no-station" };
      if (!Object.prototype.hasOwnProperty.call(STATION_COORDINATES, station)) return { status: "unavailable", reason: "no-mapping" };
      const key = apiKey();
      if (!key) return { status: "unavailable", reason: "not-configured" };
      const ck = coordKey(station);

      const cached = cache.get(ck);
      if (cached && now() - cached.at < ttlMs) {
        const p = parseHourly(cached.raw, now());
        if (p.status === "ok") return { ...p, fetchedAt: new Date(cached.at).toISOString() };
      }
      let pending = inflight.get(ck);
      if (!pending) {
        const url = weatherApiUrl(station, key)!;
        pending = fetchRaw(url).finally(() => inflight.delete(ck));
        inflight.set(ck, pending);
      }
      const raw = await pending;
      if (raw !== null) {
        const p = parseHourly(raw, now());
        if (p.status === "ok") {
          cache.set(ck, { at: now(), raw });
          return { ...p, fetchedAt: new Date(now()).toISOString() };
        }
        backoffUntil = now() + backoffMs;
      }
      if (cached) {
        const p = parseHourly(cached.raw, now());
        if (p.status === "ok") return { ...p, stale: true, fetchedAt: new Date(cached.at).toISOString() };
      }
      return { status: "unavailable", reason: "upstream" };
    },
  };
}

export const hourlyService = createHourlyService();
