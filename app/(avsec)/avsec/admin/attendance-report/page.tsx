import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { STATIONS, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { getAttendanceRows, applyAttendanceFlag, type AttendanceFlag, type AttendanceRow } from "@/lib/avsec/duty/attendance-queries";
import { runAttendanceSweep } from "@/lib/avsec/duty/attendance-actions";
import { formatDateMY, formatTimeMY, todayISODateMY } from "@/lib/avsec/datetime";
import { initials } from "@/lib/avsec/utils";

const FLAG_TABS: { value: AttendanceFlag; label: string }[] = [
  { value: "all", label: "All" },
  { value: "missing", label: "Missing Checkout" },
  { value: "noshow", label: "No-Show" },
  { value: "offschedule", label: "Off-Schedule" },
];

function formatHours(minutes: number | null): string {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function daysAgo(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function AttendanceReportPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{
    dateFrom?: string;
    dateTo?: string;
    station?: string;
    team?: string;
    q?: string;
    flag?: string;
    error?: string;
    swept?: string;
  }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole([...ORG_WIDE_ROLES]);

  const today = todayISODateMY();
  const dateFrom = searchParams.dateFrom || daysAgo(today, 6);
  const dateTo = searchParams.dateTo || today;
  const station = searchParams.station || "";
  const team = searchParams.team || "";
  const search = searchParams.q || "";
  const flag: AttendanceFlag = (["all", "missing", "noshow", "offschedule"] as const).includes(
    searchParams.flag as AttendanceFlag,
  )
    ? (searchParams.flag as AttendanceFlag)
    : "all";

  const allRows = await getAttendanceRows({ station: station || undefined, team: team || undefined, dateFrom, dateTo, search });
  const rows = applyAttendanceFlag(allRows, flag);

  const counts = {
    all: allRows.length,
    missing: allRows.filter((r) => r.is_missing_checkout).length,
    noshow: allRows.filter((r) => r.is_no_show).length,
    offschedule: allRows.filter((r) => r.is_off_schedule).length,
  };

  const baseQs = new URLSearchParams({ dateFrom, dateTo, station, team, q: search });
  const exportQs = new URLSearchParams({ dateFrom, dateTo, station, team, q: search, flag });

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">Attendance Report</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Built from actual check-in/out records, cross-referenced against the roster.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}
        {searchParams.swept && (
          <div className="disclaimer-band border-success text-success bg-success/10">
            Anomaly sweep complete — flags refreshed.
          </div>
        )}

        <form method="get" className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
          <div>
            <label className="field-label">From</label>
            <input type="date" name="dateFrom" defaultValue={dateFrom} className="input-base" />
          </div>
          <div>
            <label className="field-label">To</label>
            <input type="date" name="dateTo" defaultValue={dateTo} className="input-base" />
          </div>
          <div>
            <label className="field-label">Station</label>
            <select name="station" defaultValue={station} className="input-base">
              <option value="">All</option>
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Team</label>
            <input type="text" name="team" defaultValue={team} placeholder="All" className="input-base" />
          </div>
          <div>
            <label className="field-label">Search</label>
            <input
              type="text"
              name="q"
              defaultValue={search}
              placeholder="Name or staff no…"
              className="input-base"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn-secondary flex-1">
              Filter
            </button>
            <Link href={`/api/avsec/export/attendance?${exportQs.toString()}`} className="btn-secondary" title="Export CSV">
              CSV
            </Link>
          </div>
        </form>

        {(profile.role === "MANAGEMENT" || profile.role === "ADMIN") && (
          <form action={runAttendanceSweep} className="flex justify-end">
            <button type="submit" className="btn-quiet">
              ↻ Run anomaly sweep (refresh flags)
            </button>
          </form>
        )}

        {/* Flag filter tabs */}
        <div className="flex flex-wrap gap-1.5">
          {FLAG_TABS.map((t) => {
            const active = flag === t.value;
            const qs = new URLSearchParams(baseQs);
            if (t.value !== "all") qs.set("flag", t.value);
            else qs.delete("flag");
            return (
              <Link
                key={t.value}
                href={`/avsec/admin/attendance-report?${qs.toString()}`}
                className={`rounded-full border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label} · {counts[t.value]}
              </Link>
            );
          })}
        </div>

        <details className="card p-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-semibold text-foreground">
            What do these flags mean?
          </summary>
          <ul className="mt-2 space-y-1.5 list-disc pl-5">
            <li>
              <strong className="text-destructive">No-Show</strong> — the officer&apos;s team was
              rostered to work that day, but they never checked in at all.
            </li>
            <li>
              <strong className="text-destructive">Missing Checkout</strong> — they checked in but
              never checked out, and the shift&apos;s end time (plus a grace period) has already passed.
              No hour total is shown for these — a missed checkout was never a real duration.
            </li>
            <li>
              <strong className="text-primary">Off-Schedule</strong> — they checked in on a day
              their team&apos;s roster explicitly marks as an Off Day.
            </li>
            <li>Flags refresh automatically overnight, or on demand via &quot;Run anomaly sweep&quot; (Admin only).</li>
          </ul>
        </details>

        {/* Desktop table */}
        <div className="card p-4 overflow-x-auto hidden sm:block">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b border-border">
                {["Officer", "Station / Team", "Date", "Check In", "Check Out", "Total Hours", ""].map((h) => (
                  <th key={h} className="text-left p-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <AttendanceRowDesktop key={r.id} row={r} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-sm text-muted-foreground">
                    No attendance records for this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="space-y-2 sm:hidden">
          {rows.length === 0 && (
            <p className="text-sm text-center py-4 text-muted-foreground">
              No attendance records for this filter.
            </p>
          )}
          {rows.map((r) => (
            <AttendanceCardMobile key={r.id} row={r} />
          ))}
        </div>
      </div>
    </main>
  );
}

function StatusPills({ row }: { row: AttendanceRow }) {
  return (
    <>
      {row.is_no_show && <Pill color="red">NO-SHOW</Pill>}
      {row.is_missing_checkout && <Pill color="red">MISSING CHECKOUT</Pill>}
      {row.is_off_schedule && <Pill color="gold">OFF-SCHEDULE</Pill>}
      {row.ot_minutes != null && (
        row.ot_request_id ? (
          <Link href={`/avsec/duty/overtime/${row.ot_request_id}`}>
            <Pill color="green">+{formatHours(row.ot_minutes)} OT →</Pill>
          </Link>
        ) : (
          <Pill color="green">+{formatHours(row.ot_minutes)} OT (unclaimed)</Pill>
        )
      )}
    </>
  );
}

function Pill({ color, children }: { color: "red" | "gold" | "green"; children: React.ReactNode }) {
  const colorMap = {
    red: "border-destructive/40 bg-destructive/10 text-destructive",
    gold: "border-primary/40 bg-primary/10 text-primary",
    green: "border-success/40 bg-success/10 text-success",
  };
  return (
    <span
      className={`font-mono text-[8.5px] font-bold px-1.5 py-0.5 inline-block rounded border uppercase tracking-wider ${colorMap[color]}`}
    >
      {children}
    </span>
  );
}

function AttendanceRowDesktop({ row }: { row: AttendanceRow }) {
  return (
    <tr className="hover:bg-card/40 transition-colors">
      <td className="p-2 align-top">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center font-mono text-[9.5px] font-bold bg-primary/20 text-primary border border-primary/30">
            {initials(row.staff_name)}
          </span>
          <div>
            <p className="font-semibold text-xs text-foreground">
              {row.staff_name}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {row.staff_no}
            </p>
          </div>
        </div>
      </td>
      <td className="p-2 align-top font-mono text-xs text-foreground/80">
        {row.station}
        <br />
        <span className="text-muted-foreground">{row.team || "—"}</span>
      </td>
      <td className="p-2 align-top font-mono text-xs text-muted-foreground">
        {formatDateMY(row.duty_date)}
      </td>
      <td className="p-2 align-top font-mono text-xs text-muted-foreground">
        {formatTimeMY(row.check_in_at)}
      </td>
      <td className="p-2 align-top font-mono text-xs">
        {row.is_missing_checkout ? <span className="text-destructive font-semibold">Missing</span> : <span className="text-muted-foreground">{formatTimeMY(row.check_out_at)}</span>}
      </td>
      <td className="p-2 align-top font-mono text-xs font-semibold text-foreground">
        {row.is_missing_checkout ? "—" : formatHours(row.total_minutes)}
      </td>
      <td className="p-2 align-top">
        <div className="flex flex-col gap-1 items-start">
          <StatusPills row={row} />
        </div>
      </td>
    </tr>
  );
}

function AttendanceCardMobile({ row }: { row: AttendanceRow }) {
  return (
    <div className="card p-3.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-mono text-[10px] font-bold bg-primary/20 text-primary border border-primary/30">
            {initials(row.staff_name)}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-xs text-foreground truncate">
              {row.staff_name}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {row.staff_no} · {row.station} · {row.team || "—"}
            </p>
          </div>
        </div>
        <p className="font-mono text-[10.5px] text-muted-foreground shrink-0">
          {formatDateMY(row.duty_date)}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center pt-1 border-t border-border/60">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Check In</p>
          <p className="font-mono text-xs font-semibold text-foreground mt-0.5">{formatTimeMY(row.check_in_at)}</p>
        </div>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Check Out</p>
          <p className={`font-mono text-xs font-semibold mt-0.5 ${row.is_missing_checkout ? "text-destructive" : "text-foreground"}`}>
            {row.is_missing_checkout ? "Missing" : formatTimeMY(row.check_out_at)}
          </p>
        </div>
        <div>
          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Total</p>
          <p className="font-mono text-xs font-semibold text-foreground mt-0.5">{row.is_missing_checkout ? "—" : formatHours(row.total_minutes)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        <StatusPills row={row} />
      </div>
    </div>
  );
}
