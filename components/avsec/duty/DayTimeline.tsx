interface Props {
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  checkIn: Date | null;
  checkOut: Date | null;
}

function Bar({ leftPct, widthPct, color }: { leftPct: number | null; widthPct: number | null; color: string }) {
  return (
    <div className="relative h-2 flex-1" style={{ background: "var(--panel2)" }}>
      {leftPct !== null && widthPct !== null && (
        <div
          className="absolute top-0 h-full"
          style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1.5)}%`, background: color }}
        />
      )}
    </div>
  );
}

/** Pure server-rendered planned-vs-actual bar pair, scaled to whichever of the four
 * timestamps span the widest range (plus a 30-min pad) — no client JS required. */
export function DayTimeline({ scheduledStart, scheduledEnd, checkIn, checkOut }: Props) {
  const points = [scheduledStart, scheduledEnd, checkIn, checkOut].filter((d): d is Date => !!d);
  if (points.length === 0) return null;

  const pad = 30 * 60000;
  const trackStart = Math.min(...points.map((d) => d.getTime())) - pad;
  const trackEnd = Math.max(...points.map((d) => d.getTime())) + pad;
  const span = Math.max(trackEnd - trackStart, 60000);
  const pct = (d: Date) => ((d.getTime() - trackStart) / span) * 100;

  const plannedLeft = scheduledStart ? pct(scheduledStart) : null;
  const plannedWidth = scheduledStart && scheduledEnd ? pct(scheduledEnd) - pct(scheduledStart) : null;
  const actualLeft = checkIn ? pct(checkIn) : null;
  const actualRight = checkOut ? pct(checkOut) : checkIn ? 100 : null;
  const actualWidth = actualLeft !== null && actualRight !== null ? actualRight - actualLeft : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="t-mono text-[8px] w-12 shrink-0" style={{ color: "var(--faint)" }}>
          PLANNED
        </span>
        <Bar leftPct={plannedLeft} widthPct={plannedWidth} color="var(--line3)" />
      </div>
      <div className="flex items-center gap-2">
        <span className="t-mono text-[8px] w-12 shrink-0" style={{ color: "var(--faint)" }}>
          ACTUAL
        </span>
        <Bar leftPct={actualLeft} widthPct={actualWidth} color={checkOut ? "var(--gold-fill)" : "var(--green)"} />
      </div>
    </div>
  );
}
