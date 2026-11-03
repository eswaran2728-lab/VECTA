import { test } from "node:test";
import assert from "node:assert/strict";
import { STATIONS } from "../lib/avsec/reference-data.ts";
import { STATION_FORECAST_LOCATION, forecastLocationFor } from "../lib/weather/stations.ts";
import { parseForecast, forecastUrl, describeForecast, WEATHER_ATTRIBUTION } from "../lib/weather/forecast.ts";
import { createForecastService } from "../lib/weather/service.ts";

const row = (date: string, over: Record<string, unknown> = {}) => ({
  location: { location_id: "Ds064", location_name: "Sepang" },
  date,
  morning_forecast: "Tiada Hujan",
  afternoon_forecast: "Ribut petir di beberapa tempat",
  night_forecast: "Hujan di beberapa tempat",
  summary_forecast: "Ribut petir di beberapa tempat",
  summary_when: "Petang dan Malam",
  min_temp: 23,
  max_temp: 32,
  ...over,
});
const feed = [row("2026-11-06"), row("2026-11-03"), row("2026-11-05"), row("2026-11-04")];

test("every VECTA station maps to exactly one official forecast location; unknown or missing stations do not", () => {
  for (const s of STATIONS) assert.ok(STATION_FORECAST_LOCATION[s]?.id.match(/^Ds\d{3}$/), s);
  assert.equal(forecastLocationFor("KUL - MAA")?.id, "Ds064");
  assert.equal(forecastLocationFor("KUL - AAX")?.id, "Ds064");
  assert.equal(forecastLocationFor(null), null, "a group role without a station");
  assert.equal(forecastLocationFor(""), null);
  assert.equal(forecastLocationFor("ZZZ"), null);
});

test("the request is the official keyless endpoint for one location and exactly today through three days ahead", () => {
  const u = new URL(forecastUrl("Ds064", "2026-11-03"));
  assert.equal(u.origin + u.pathname, "https://api.data.gov.my/weather/forecast/");
  assert.equal(u.searchParams.get("filter"), "Ds064@location__location_id");
  assert.equal(u.searchParams.get("date_start"), "2026-11-03@date");
  assert.equal(u.searchParams.get("date_end"), "2026-11-06@date");
  assert.equal([...u.searchParams.keys()].some((k) => /key|token|auth/i.test(k)), false);
});

test("today's morning, afternoon and night plus the next three days, in date order", () => {
  const r = parseForecast(feed, "Ds064", "2026-11-03");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual([r.today.morning, r.today.afternoon, r.today.night], ["Tiada Hujan", "Ribut petir di beberapa tempat", "Hujan di beberapa tempat"]);
  assert.deepEqual(r.next.map((d) => d.date), ["2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.equal(r.today.minTemp, 23);
  assert.equal(r.locationName, "Sepang");
});

test("a feed without today's entry (stale) or for another location is unavailable, never guessed", () => {
  assert.deepEqual(parseForecast(feed.filter((x) => x.date !== "2026-11-03"), "Ds064", "2026-11-03"), { status: "unavailable", reason: "stale" });
  assert.deepEqual(parseForecast(feed, "Ds001", "2026-11-03"), { status: "unavailable", reason: "no-data" });
  assert.deepEqual(parseForecast([], "Ds064", "2026-11-03"), { status: "unavailable", reason: "no-data" });
});

test("malformed responses are unavailable and never throw", () => {
  for (const bad of [null, undefined, "x", 7, {}, { data: 1 }, [null], [{}], [row("not-a-date")], [row("2026-11-03", { morning_forecast: 5 })], [row("2026-11-03", { location: null })]]) {
    const r = parseForecast(bad as never, "Ds064", "2026-11-03");
    assert.equal(r.status, "unavailable");
  }
});

test("a missing future day is left out rather than failing the card", () => {
  const r = parseForecast([row("2026-11-03"), row("2026-11-05")], "Ds064", "2026-11-03");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.deepEqual(r.next.map((d) => d.date), ["2026-11-05"]);
});

test("malay forecast phrases are translated; unknown phrases are shown as published", () => {
  assert.equal(describeForecast("Tiada Hujan"), "No rain");
  assert.equal(describeForecast("Ribut petir di beberapa tempat"), "Thunderstorms at some places");
  assert.equal(describeForecast("Hujan di kebanyakan tempat"), "Rain at most places");
  assert.equal(describeForecast("Sesuatu Baharu"), "Sesuatu Baharu");
});

test("attribution names MET Malaysia and data.gov.my under CC BY 4.0 and never claims observations or aviation clearance", () => {
  assert.match(WEATHER_ATTRIBUTION, /MET Malaysia/);
  assert.match(WEATHER_ATTRIBUTION, /data\.gov\.my/);
  assert.match(WEATHER_ATTRIBUTION, /CC BY 4\.0/);
  assert.match(WEATHER_ATTRIBUTION, /not live observations/i);
  assert.match(WEATHER_ATTRIBUTION, /not aviation weather clearance/i);
  assert.doesNotMatch(WEATHER_ATTRIBUTION, /\blive weather\b|cleared for/i);
});

const okFetch = (calls: string[]) => async (url: string) => {
  calls.push(url);
  return { ok: true, status: 200, json: async () => feed } as Response;
};

test("requests are cached: many page views make one upstream call per location, far below four per minute", async () => {
  const calls: string[] = [];
  const now = Date.parse("2026-11-03T02:00:00Z");
  const svc = createForecastService({ fetchImpl: okFetch(calls), now: () => now });
  for (let i = 0; i < 50; i += 1) assert.equal((await svc.get("KUL - MAA")).status, "ok");
  assert.equal(calls.length, 1);
  assert.equal((await svc.get("KUL - AAX")).status, "ok");
  assert.equal(calls.length, 1, "two stations sharing a location share the cache");
});

test("concurrent first views share one in-flight request", async () => {
  const calls: string[] = [];
  const svc = createForecastService({
    fetchImpl: async (u: string) => {
      calls.push(u);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => feed } as Response;
    },
    now: () => Date.parse("2026-11-03T02:00:00Z"),
  });
  const all = await Promise.all(Array.from({ length: 10 }, () => svc.get("KUL - MAA")));
  assert.ok(all.every((r) => r.status === "ok"));
  assert.equal(calls.length, 1);
});

test("upstream calls for different locations are spaced so the service stays under four per minute", async () => {
  const stamps: number[] = [];
  let now = Date.parse("2026-11-03T02:00:00Z");
  const svc = createForecastService({
    fetchImpl: async (u: string) => {
      stamps.push(now);
      const id = new URL(u).searchParams.get("filter")!.split("@")[0];
      const body = feed.map((r) => ({ ...r, location: { location_id: id, location_name: "X" } }));
      return { ok: true, status: 200, json: async () => body } as Response;
    },
    now: () => now,
    minGapMs: 20_000,
    sleep: async (ms: number) => {
      now += ms;
    },
  });
  await svc.get("KUL - MAA");
  await svc.get("PEN");
  await svc.get("BKI");
  await svc.get("KCH");
  assert.equal(stamps.length, 4);
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] - stamps[i - 1] >= 20_000, `gap ${i}`);
});

test("HTTP 429 leaves the workspace usable: last good data is served as stale, else a safe unavailable state, and the upstream is not hammered", async () => {
  const calls: string[] = [];
  let now = Date.parse("2026-11-03T02:00:00Z");
  let mode: "ok" | "429" = "ok";
  const svc = createForecastService({
    fetchImpl: async (u: string) => {
      calls.push(u);
      return mode === "ok" ? ({ ok: true, status: 200, json: async () => feed } as Response) : ({ ok: false, status: 429, json: async () => ({}) } as Response);
    },
    now: () => now,
    ttlMs: 3 * 3600_000,
    sleep: async () => {},
  });
  assert.equal((await svc.get("KUL - MAA")).status, "ok");
  mode = "429";
  now += 4 * 3600_000 - 1; // still the same Malaysia day, but past the cache lifetime
  const stale = await svc.get("KUL - MAA");
  assert.equal(stale.status, "ok");
  if (stale.status === "ok") assert.equal(stale.stale, true);
  const before = calls.length;
  for (let i = 0; i < 20; i += 1) await svc.get("KUL - MAA");
  assert.equal(calls.length, before, "a failure backs off instead of retrying on every view");
  assert.deepEqual(await svc.get("PEN"), { status: "unavailable", reason: "upstream" });
});

test("a timeout or network error is a safe unavailable state, and malformed JSON never throws", async () => {
  const now = () => Date.parse("2026-11-03T02:00:00Z");
  const sleep = async () => {};
  assert.deepEqual(await createForecastService({ fetchImpl: async () => { throw new Error("aborted"); }, now, sleep }).get("KUL - MAA"), { status: "unavailable", reason: "upstream" });
  assert.deepEqual(
    await createForecastService({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) as Response, now, sleep }).get("KUL - MAA"),
    { status: "unavailable", reason: "upstream" },
  );
  assert.equal((await createForecastService({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }) as Response, now, sleep }).get("KUL - MAA")).status, "unavailable");
});

test("a station with no mapping, or no station at all, never calls the upstream", async () => {
  const calls: string[] = [];
  const svc = createForecastService({ fetchImpl: okFetch(calls), now: () => Date.parse("2026-11-03T02:00:00Z") });
  assert.deepEqual(await svc.get(null), { status: "unavailable", reason: "no-station" });
  assert.deepEqual(await svc.get("ZZZ"), { status: "unavailable", reason: "no-mapping" });
  assert.equal(calls.length, 0);
});

test("the Malaysia date decides which entry is today across midnight", async () => {
  const calls: string[] = [];
  // 16:00 UTC on 3 Nov is already 4 Nov in Malaysia
  const svc = createForecastService({ fetchImpl: okFetch(calls), now: () => Date.parse("2026-11-03T16:00:00Z") });
  const r = await svc.get("KUL - MAA");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.today.date, "2026-11-04");
});
