import { Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSun, Droplets, Moon, Sun } from "lucide-react";
import { forecastService } from "@/lib/weather/service";
import { describeForecast, WEATHER_ATTRIBUTION, type ForecastDay, type ForecastResult } from "@/lib/weather/forecast";
import { hourlyService, type ConditionIcon, type HourlyItem, type HourlyResult } from "@/lib/weather/hourly";

const MET_REASON: Record<string, string> = {
  "no-station": "Daily forecast appears once you have a station assignment.",
  "no-mapping": "No official daily forecast location is set up for this station yet.",
  stale: "Today's daily forecast has not been published yet.",
};
const HOURLY_REASON: Record<string, string> = {
  "no-station": "Hourly forecast appears once you have a station assignment.",
  "no-mapping": "No hourly forecast location is set up for this station yet.",
};

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const temp = (d: ForecastDay) => (d.minTemp !== null && d.maxTemp !== null ? `${d.minTemp}–${d.maxTemp}°C` : "");

const ICONS: Record<ConditionIcon, typeof Sun> = { sun: Sun, moon: Moon, "cloud-sun": CloudSun, "cloud-moon": CloudMoon, cloud: Cloud, fog: CloudFog, rain: CloudRain, thunder: CloudLightning };

function HourIcon({ icon }: { icon: ConditionIcon }) {
  const I = ICONS[icon];
  return <I aria-hidden="true" className="h-6 w-6 text-primary" />;
}

function HourTile({ h }: { h: HourlyItem }) {
  const rain = h.rainChance === null ? "rain chance not given" : `${h.rainChance} percent chance of rain`;
  return (
    <li
      aria-label={`${h.isNow ? "Now, " : ""}${h.label}: ${h.condition}, ${h.tempC} degrees Celsius, ${rain}`}
      className={`flex w-[34%] min-w-[104px] max-w-[132px] shrink-0 snap-start flex-col items-center gap-1 rounded-xl border px-2 py-2 ${h.isNow ? "border-primary bg-primary/10" : "border-border/70 bg-background/60"}`}
    >
      <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">{h.isNow ? "Now" : h.label}</span>
      <HourIcon icon={h.icon} />
      <span className="font-display text-lg font-bold leading-none text-foreground">{h.tempC}°</span>
      <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
        <Droplets aria-hidden="true" className="h-3 w-3" />
        {h.rainChance === null ? "—" : `${h.rainChance}%`}
      </span>
    </li>
  );
}

function HourlySection({ result }: { result: HourlyResult }) {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Hourly · WeatherAPI.com{result.status === "ok" && result.stale ? " · last update" : ""}</p>
      {result.status === "ok" ? (
        <ol
          role="list"
          tabIndex={0}
          aria-label="Hourly forecast. Scroll sideways for later hours."
          data-testid="hourly-strip"
          className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-primary [scrollbar-width:thin]"
        >
          {result.hours.map((h) => (
            <HourTile key={h.epochMs} h={h} />
          ))}
        </ol>
      ) : (
        <p data-testid="hourly-unavailable" className="font-mono text-xs text-muted-foreground">
          {HOURLY_REASON[result.reason] ?? "Hourly forecast is temporarily unavailable. The rest of your workspace is not affected."}
        </p>
      )}
    </div>
  );
}

function MetSection({ result }: { result: ForecastResult }) {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        Daily · MET Malaysia{result.status === "ok" ? ` · ${result.locationName} district${result.stale ? " · last published" : ""}` : ""}
      </p>
      {result.status === "ok" ? (
        <div className="grid grid-cols-3 gap-1.5" data-testid="met-today">
          {([["Morning", result.today.morning], ["Afternoon", result.today.afternoon], ["Night", result.today.night]] as const).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border/60 bg-background/60 p-1.5">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="text-xs leading-tight text-foreground" title={value}>{describeForecast(value)}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">{MET_REASON[result.reason] ?? "The daily forecast is temporarily unavailable. The rest of your workspace is not affected."}</p>
      )}
    </div>
  );
}

/** Reserves the card's space while the forecast loads, so the page below does not jump and Duty Check-In stays in the same place. */
export function StationWeatherSkeleton() {
  return (
    <section aria-label="Station weather forecast" aria-busy="true" className="card space-y-2 p-3" data-testid="station-weather-loading">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[92px] w-[34%] min-w-[104px] shrink-0 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <p className="sr-only" role="status">Loading weather forecast</p>
    </section>
  );
}

/**
 * Compact station weather: an hourly strip (WeatherAPI.com, swipeable, two to three hours visible on a phone), today's daily outlook from MET Malaysia, and a
 * "Details" disclosure with the rest. The two sources are shown and sourced separately and fail independently: one being unavailable never hides the other.
 * Server component: the browser never calls either provider and the key never leaves the server.
 */
export async function StationWeatherCard({ station }: { station: string | null | undefined }) {
  const [met, hourly] = await Promise.all([forecastService.get(station), hourlyService.get(station)]);
  return (
    <section aria-label="Station weather forecast" className="card space-y-2.5 p-3" data-testid="station-weather">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="section-title">Weather{station ? ` · ${station}` : ""}</h2>
        {met.status === "ok" && <span className="font-mono text-[11px] text-muted-foreground">{weekday(met.today.date)}</span>}
      </div>

      <HourlySection result={hourly} />
      <MetSection result={met} />

      <details className="group rounded-lg border border-border/60">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3 font-mono text-xs font-semibold text-foreground">
          <span>More detail</span>
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="space-y-3 border-t border-border/60 p-3">
          {hourly.status === "ok" && (
            <div className="space-y-1">
              <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Next hours · WeatherAPI.com</p>
              <ul className="divide-y divide-border/40">
                {hourly.hours.slice(0, 12).map((h) => (
                  <li key={h.epochMs} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <span className="w-12 shrink-0 font-mono text-foreground">{h.isNow ? "Now" : h.label}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{h.condition}</span>
                    <span className="font-mono text-muted-foreground">{h.tempC}° · {h.rainChance === null ? "—" : `${h.rainChance}%`}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {met.status === "ok" && (
            <div className="space-y-1">
              <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Next days · MET Malaysia</p>
              {temp(met.today) && <p className="font-mono text-[11px] text-muted-foreground">Today {temp(met.today)}</p>}
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                {met.next.map((d) => (
                  <li key={d.date} className="rounded-lg border border-border/60 p-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{weekday(d.date)}</p>
                    <p className="text-xs text-foreground" title={d.summary}>{describeForecast(d.summary)}</p>
                    {temp(d) && <p className="font-mono text-[11px] text-muted-foreground">{temp(d)}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="font-mono text-[10px] text-muted-foreground">{WEATHER_ATTRIBUTION}</p>
        </div>
      </details>

      <p className="font-mono text-[10px] leading-snug text-muted-foreground" data-testid="weather-disclaimer">
        Hourly: WeatherAPI.com · Daily: MET Malaysia via data.gov.my (CC BY 4.0). Forecast only, not live observations and not aviation weather clearance.
      </p>
    </section>
  );
}
