/**
 * Pure parsing and wording for the MET Malaysia general forecast served by data.gov.my. This is a DAILY GENERAL forecast for a district. It is not an
 * observation of current conditions and is not aviation weather (no METAR/TAF, no clearance); the wording here must never suggest otherwise.
 */
export const WEATHER_ATTRIBUTION =
  "General daily forecast for the district, from MET Malaysia via data.gov.my (CC BY 4.0). Not live observations and not aviation weather clearance.";

const DAY_MS = 86_400_000;
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

/** Malaysia (UTC+8, no DST) calendar date of an instant. */
export function malaysiaDate(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function forecastUrl(locationId: string, today: string): string {
  const u = new URL("https://api.data.gov.my/weather/forecast/");
  u.searchParams.set("filter", `${locationId}@location__location_id`);
  u.searchParams.set("date_start", `${today}@date`);
  u.searchParams.set("date_end", `${isoDay(dayNo(today) + 3)}@date`);
  u.searchParams.set("sort", "date");
  return u.toString();
}

export interface ForecastDay {
  date: string;
  morning: string;
  afternoon: string;
  night: string;
  summary: string;
  minTemp: number | null;
  maxTemp: number | null;
}

export type ForecastResult =
  | { status: "ok"; locationName: string; today: ForecastDay; next: ForecastDay[]; stale?: boolean; fetchedAt?: string }
  | { status: "unavailable"; reason: "no-data" | "stale" | "upstream" | "no-station" | "no-mapping" };

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toDay(x: unknown, locationId: string): { day: ForecastDay; name: string } | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const loc = r.location as Record<string, unknown> | null | undefined;
  if (!loc || typeof loc !== "object" || loc.location_id !== locationId || !isStr(loc.location_name)) return null;
  if (!isStr(r.date) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) return null;
  if (!isStr(r.morning_forecast) || !isStr(r.afternoon_forecast) || !isStr(r.night_forecast)) return null;
  return {
    name: loc.location_name,
    day: {
      date: r.date,
      morning: r.morning_forecast,
      afternoon: r.afternoon_forecast,
      night: r.night_forecast,
      summary: isStr(r.summary_forecast) ? r.summary_forecast : r.afternoon_forecast,
      minTemp: num(r.min_temp),
      maxTemp: num(r.max_temp),
    },
  };
}

/** Today's entry and the three days after it (Malaysia dates). Anything malformed, for another location or without today is unavailable; nothing is guessed. */
export function parseForecast(raw: unknown, locationId: string, today: string): ForecastResult {
  if (!Array.isArray(raw)) return { status: "unavailable", reason: "no-data" };
  const days: ForecastDay[] = [];
  let name = "";
  for (const x of raw) {
    const d = toDay(x, locationId);
    if (d) {
      name = d.name;
      days.push(d.day);
    }
  }
  if (days.length === 0) return { status: "unavailable", reason: "no-data" };
  const byDate = new Map(days.map((d) => [d.date, d]));
  const t = byDate.get(today);
  if (!t) return { status: "unavailable", reason: "stale" };
  const next: ForecastDay[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const d = byDate.get(isoDay(dayNo(today) + i));
    if (d) next.push(d);
  }
  return { status: "ok", locationName: name, today: t, next };
}

const PHRASES: Record<string, string> = {
  "tiada hujan": "No rain",
  hujan: "Rain",
  "hujan menyeluruh": "Rain everywhere",
  "hujan di satu dua tempat": "Isolated rain",
  "hujan di beberapa tempat": "Rain at some places",
  "hujan di kebanyakan tempat": "Rain at most places",
  "ribut petir": "Thunderstorms",
  "ribut petir di satu dua tempat": "Thunderstorms at isolated places",
  "ribut petir di beberapa tempat": "Thunderstorms at some places",
  "ribut petir di kebanyakan tempat": "Thunderstorms at most places",
  berjerebu: "Hazy",
};

/** English wording for the published Malay phrase. A phrase not in the table is shown exactly as published. */
export function describeForecast(phrase: string): string {
  const key = phrase.trim().toLowerCase();
  if (PHRASES[key]) return PHRASES[key];
  const m = /^(.*?) di kawasan (pedalaman|pantai)$/.exec(key);
  if (m && PHRASES[m[1]]) return `${PHRASES[m[1]]} ${m[2] === "pedalaman" ? "inland" : "on the coast"}`;
  return phrase;
}
