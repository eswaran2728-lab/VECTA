import { test } from "node:test";
import assert from "node:assert/strict";
import { STATIONS } from "../lib/avsec/reference-data.ts";
import { STATION_COORDINATES, weatherApiUrl, parseHourly, conditionIcon, createHourlyService } from "../lib/weather/hourly.ts";

const KEY = "test-key-not-a-secret-0123456789";
const hour = (h: number, over: Record<string, unknown> = {}) => ({
  time_epoch: Date.parse(`2026-11-03T${String(h).padStart(2, "0")}:00:00+08:00`) / 1000,
  time: `2026-11-03 ${String(h).padStart(2, "0")}:00`,
  temp_c: 25 + (h % 10),
  is_day: h >= 7 && h < 19 ? 1 : 0,
  condition: { text: "Patchy rain nearby", code: 1063 },
  chance_of_rain: 40 + h,
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  location: { name: "Sepang", tz_id: "Asia/Kuala_Lumpur" },
  forecast: {
    forecastday: [
      { date: "2026-11-03", hour: Array.from({ length: 24 }, (_, h) => hour(h)) },
      { date: "2026-11-04", hour: Array.from({ length: 24 }, (_, h) => ({ ...hour(h), time_epoch: hour(h).time_epoch + 86400, time: `2026-11-04 ${String(h).padStart(2, "0")}:00` })) },
    ],
  },
  ...over,
});
const NOW = Date.parse("2026-11-03T14:20:00+08:00");

test("every VECTA station has airport coordinates inside Malaysia", () => {
  for (const s of STATIONS) {
    const c = STATION_COORDINATES[s];
    assert.ok(c, s);
    assert.ok(c.lat > 0.5 && c.lat < 7.5 && c.lng > 99 && c.lng < 120, `${s} ${JSON.stringify(c)}`);
  }
});

test("the request is the WeatherAPI forecast for the station coordinates, two days, hourly data only", () => {
  const u = new URL(weatherApiUrl("KUL - MAA", KEY)!);
  assert.equal(u.origin + u.pathname, "https://api.weatherapi.com/v1/forecast.json");
  assert.match(u.searchParams.get("q")!, /^2\.\d+,101\.\d+$/);
  assert.equal(u.searchParams.get("days"), "2");
  assert.equal(u.searchParams.get("aqi"), "no");
  assert.equal(u.searchParams.get("alerts"), "no");
  assert.equal(u.searchParams.get("key"), KEY);
  assert.equal(weatherApiUrl("ZZZ", KEY), null);
});

test("the strip starts at the current hour and uses the real time, temperature, condition and rain chance of each hour", () => {
  const r = parseHourly(body(), NOW);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.hours[0].label, "2 PM", "14:20 shows the 2 PM hour as the current one");
  assert.equal(r.hours[0].tempC, 25 + (14 % 10));
  assert.equal(r.hours[0].rainChance, 54);
  assert.equal(r.hours[0].condition, "Patchy rain nearby");
  assert.equal(r.hours[0].isNow, true);
  assert.equal(r.hours.length, 24);
  assert.equal(r.hours[10].label, "12 AM", "the strip continues across midnight into the next day");
  assert.equal(r.hours[1].isNow, false);
});

test("values are never invented: a changed feed changes the output", () => {
  const b = body();
  (b.forecast.forecastday[0].hour[14] as Record<string, unknown>).temp_c = 41.4;
  (b.forecast.forecastday[0].hour[14] as Record<string, unknown>).chance_of_rain = "7";
  (b.forecast.forecastday[0].hour[14] as Record<string, unknown>).condition = { text: "Sunny", code: 1000 };
  const r = parseHourly(b, NOW);
  assert.equal(r.status === "ok" && r.hours[0].tempC, 41);
  assert.equal(r.status === "ok" && r.hours[0].rainChance, 7, "a rain chance given as a string is read");
  assert.equal(r.status === "ok" && r.hours[0].condition, "Sunny");
});

test("an hour missing time, temperature or condition is skipped; a missing rain chance is shown as unknown, not zero", () => {
  const b = body();
  const hrs = b.forecast.forecastday[0].hour as Record<string, unknown>[];
  delete hrs[15].temp_c;
  delete hrs[16].chance_of_rain;
  hrs[17].condition = null;
  const r = parseHourly(b, NOW);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const labels = r.hours.map((h) => h.label);
  assert.ok(labels.length <= 24);
  assert.ok(!r.hours.some((h) => h.epochMs === hour(15).time_epoch * 1000 || h.epochMs === hour(17).time_epoch * 1000), "today's 3 PM and 5 PM are skipped");
  assert.equal(r.hours.find((h) => h.label === "4 PM")?.rainChance, null);
});

test("malformed or empty responses are unavailable and never throw", () => {
  for (const bad of [null, undefined, "x", 7, {}, { forecast: {} }, { forecast: { forecastday: [] } }, { forecast: { forecastday: [{ hour: "no" }] } }, { error: { code: 2008, message: "key disabled" } }]) {
    assert.equal(parseHourly(bad as never, NOW).status, "unavailable");
  }
  assert.equal(parseHourly(body(), Date.parse("2026-12-25T10:00:00+08:00")).status, "unavailable", "a feed that does not cover now is unavailable, not shown stale as current");
});

test("condition codes map to a small, honest icon set (day and night)", () => {
  assert.equal(conditionIcon(1000, true), "sun");
  assert.equal(conditionIcon(1000, false), "moon");
  assert.equal(conditionIcon(1003, true), "cloud-sun");
  assert.equal(conditionIcon(1003, false), "cloud-moon");
  assert.equal(conditionIcon(1009, true), "cloud");
  assert.equal(conditionIcon(1135, true), "fog");
  assert.equal(conditionIcon(1195, true), "rain");
  assert.equal(conditionIcon(1276, true), "thunder");
  assert.equal(conditionIcon(9999, true), "cloud", "an unknown code falls back to a neutral cloud");
});

const ok200 = (b: unknown, calls: string[]) => async (url: string) => {
  calls.push(url);
  return { ok: true, status: 200, json: async () => b } as Response;
};

test("without a configured key nothing is fetched and the state is not-configured", async () => {
  const calls: string[] = [];
  const svc = createHourlyService({ apiKey: () => undefined, fetchImpl: ok200(body(), calls), now: () => NOW });
  assert.deepEqual(await svc.get("KUL - MAA"), { status: "unavailable", reason: "not-configured" });
  assert.equal(calls.length, 0);
});

test("a station with no coordinates or no station never calls the provider", async () => {
  const calls: string[] = [];
  const svc = createHourlyService({ apiKey: () => KEY, fetchImpl: ok200(body(), calls), now: () => NOW });
  assert.deepEqual(await svc.get(null), { status: "unavailable", reason: "no-station" });
  assert.deepEqual(await svc.get("ZZZ"), { status: "unavailable", reason: "no-mapping" });
  assert.equal(calls.length, 0);
});

test("requests are cached and shared: many views make one call per station per cache period", async () => {
  const calls: string[] = [];
  const svc = createHourlyService({ apiKey: () => KEY, fetchImpl: ok200(body(), calls), now: () => NOW });
  const all = await Promise.all(Array.from({ length: 30 }, () => svc.get("KUL - MAA")));
  assert.ok(all.every((r) => r.status === "ok"));
  assert.equal(calls.length, 1);
  assert.equal((await svc.get("KUL - AAX")).status, "ok");
  assert.equal(calls.length, 1, "two stations at the same airport share the cache");
});

test("a provider failure (429, 403, timeout, bad JSON) is a safe unavailable state, serves last good data as stale, and backs off", async () => {
  const calls: string[] = [];
  let now = NOW;
  let mode: "ok" | "429" | "throw" | "badjson" = "ok";
  const svc = createHourlyService({
    apiKey: () => KEY,
    now: () => now,
    ttlMs: 20 * 60_000,
    fetchImpl: async (u: string) => {
      calls.push(u);
      if (mode === "throw") throw new Error(`aborted ${u}`);
      if (mode === "429") return { ok: false, status: 429, json: async () => ({}) } as Response;
      if (mode === "badjson") return { ok: true, status: 200, json: async () => { throw new Error("bad"); } } as Response;
      return { ok: true, status: 200, json: async () => body() } as Response;
    },
  });
  assert.equal((await svc.get("KUL - MAA")).status, "ok");
  now += 25 * 60_000;
  mode = "429";
  const stale = await svc.get("KUL - MAA");
  assert.equal(stale.status, "ok");
  if (stale.status === "ok") assert.equal(stale.stale, true);
  const n = calls.length;
  for (let i = 0; i < 20; i += 1) await svc.get("KUL - MAA");
  assert.equal(calls.length, n, "backs off instead of retrying on every view");
  for (const m of ["throw", "badjson"] as const) {
    mode = m;
    const fresh = createHourlyService({ apiKey: () => KEY, now: () => NOW, fetchImpl: async () => { if (m === "throw") throw new Error("timeout"); return { ok: true, status: 200, json: async () => { throw new Error("bad"); } } as Response; } });
    assert.deepEqual(await fresh.get("PEN"), { status: "unavailable", reason: "upstream" });
  }
});

test("the API key never appears in any result, error or thrown value", async () => {
  const svc = createHourlyService({ apiKey: () => KEY, now: () => NOW, fetchImpl: async (u: string) => { throw new Error(`failed ${u}`); } });
  const r = await svc.get("KUL - MAA");
  assert.equal(JSON.stringify(r).includes(KEY), false);
  const ok = createHourlyService({ apiKey: () => KEY, now: () => NOW, fetchImpl: ok200(body(), []) });
  assert.equal(JSON.stringify(await ok.get("KUL - MAA")).includes(KEY), false);
});
