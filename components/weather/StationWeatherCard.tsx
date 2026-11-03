import { forecastService } from "@/lib/weather/service";
import { describeForecast, WEATHER_ATTRIBUTION, type ForecastDay } from "@/lib/weather/forecast";

const REASON_TEXT: Record<string, string> = {
  "no-station": "Station weather appears here once you have a station assignment.",
  "no-mapping": "No official forecast location is set up for this station yet.",
  upstream: "The official forecast is temporarily unavailable. Everything else in your workspace works as usual.",
  stale: "The official forecast for today has not been published yet.",
  "no-data": "The official forecast is temporarily unavailable. Everything else in your workspace works as usual.",
};

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function Part({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground" title={value}>{describeForecast(value)}</p>
    </div>
  );
}

function temp(d: ForecastDay) {
  return d.minTemp !== null && d.maxTemp !== null ? `${d.minTemp}–${d.maxTemp}°C` : "";
}

/**
 * Daily GENERAL forecast for the district of the person's station (today's morning, afternoon and night, then the next three days). It is a server
 * component: the browser never calls the forecast API, and the card never throws, so a failed feed cannot break the workspace around it.
 */
export async function StationWeatherCard({ station }: { station: string | null | undefined }) {
  const result = await forecastService.get(station);
  return (
    <section aria-label="Station weather forecast" className="card space-y-3 p-4" data-testid="station-weather">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title">Weather forecast{station ? ` · ${station}` : ""}</h2>
        {result.status === "ok" && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {result.locationName} district · {weekday(result.today.date)}
            {result.stale ? " · last published forecast" : ""}
          </span>
        )}
      </div>
      {result.status === "ok" ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Part label="Morning" value={result.today.morning} />
            <Part label="Afternoon" value={result.today.afternoon} />
            <Part label="Night" value={result.today.night} />
          </div>
          {temp(result.today) && <p className="font-mono text-[11px] text-muted-foreground">Today {temp(result.today)}</p>}
          {result.next.length > 0 && (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {result.next.map((d) => (
                <li key={d.date} className="rounded-lg border border-border/60 p-2">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{weekday(d.date)}</p>
                  <p className="text-sm text-foreground" title={d.summary}>{describeForecast(d.summary)}</p>
                  {temp(d) && <p className="font-mono text-[11px] text-muted-foreground">{temp(d)}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">{REASON_TEXT[result.reason] ?? REASON_TEXT.upstream}</p>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">{WEATHER_ATTRIBUTION}</p>
    </section>
  );
}
