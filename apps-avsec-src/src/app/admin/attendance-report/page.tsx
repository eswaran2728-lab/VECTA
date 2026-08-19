import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { STATIONS, ORG_WIDE_ROLES } from "@/lib/reference-data";
import { getAttendanceRows, applyAttendanceFlag, type AttendanceFlag, type AttendanceRow } from "@/lib/duty/attendance-queries";
import { runAttendanceSweep } from "@/lib/duty/attendance-actions";
import { AppHeader } from "@/components/layout/AppHeader";
import { formatDateMY, formatTimeMY, todayISODateMY } from "@/lib/datetime";
import { initials } from "@/lib/utils";

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
  searchParams,
}: {
  searchParams: {
    dateFrom?: string;
    dateTo?: string;
    station?: string;
    team?: string;
    q?: string;
    flag?: string;
    error?: string;
    swept?: string;
  };
}) {
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
      <AppHeader profile={profile} title="Attendance Report" backHref="/dashboard" />
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="t-display text-xl">Attendance Report</h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--soft)" }}>
            Built from actual check-in/out records, cross-referenced against the roster.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}
        {searchParams.swept && (
          <div className="disclaimer-band" style={{ color: "var(--green)", borderColor: "var(--green)" }}>
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
            <label className="field-label">Search officer</label>
            <input type="text" name="q" defaultValue={search} placeholder="Name or staff no." className="input-base" />
          </div>
          <input type="hidden" name="flag" value={flag} />
          <div className="col-span-2 sm:col-span-5 flex gap-3 flex-wrap">
            <button type="submit" className="btn-primary">
              Apply filters
            </button>
            <a href={`/api/export/attendance?${exportQs.toString()}`} className="btn-secondary">
              Export Excel
            </a>
            {profile.role === "ADMIN" && (
              <form action={runAttendanceSweep} className="inline">
                <input type="hidden" name="returnTo" value={`/admin/attendance-report?${baseQs.toString()}&flag=${flag}`} />
                <button type="submit" className="btn-quiet">
                  Run anomaly sweep
                </button>
              </form>
            )}
          </div>
        </form>

        <div className="flex gap-1.5 flex-wrap">
          {FLAG_TABS.map((t) => {
            const on = t.value === flag;
            const qs = new URLSearchParams({ dateFrom, dateTo, station, team, q: search, flag: t.value });
            return (
              <Link
                key={t.value}
                href={`/admin/attendance-report?${qs.toString()}`}
                className="t-mono text-[9.5px] font-semibold px-3 py-2"
                style={{
                  letterSpacing: "0.1em",
                  border: `1px solid ${on ? "var(--gold-fill)" : "var(--line3)"}`,
                  background: on ? "var(--gold-soft)" : "transparent",
                  color: on ? "var(--gold)" : "var(--mid)",
                }}
              >
                {t.label} · {counts[t.value]}
              </Link>
            );
          })}
        </div>

        <details className="card p-4 text-[12.5px]" style={{ color: "var(--soft)" }}>
          <summary className="cursor-pointer font-semibold" style={{ color: "var(--ink2)" }}>
            What do these flags mean?
          </summary>
          <ul className="mt-2 space-y-1.5 list-disc pl-5">
            <li>
              <strong style={{ color: "var(--red)" }}>No-Show</strong> — the officer&apos;s team was
              rostered to work that day, but they never checked in at all.
            </li>
            <li>
              <strong style={{ color: "var(--red)" }}>Missing Checkout</strong> — they checked in but
              never checked out, and the shift&apos;s end time (plus a grace period) has already passed.
              No hour total is shown for these — a missed checkout was never a real duration.
            </li>
            <li>
              <strong style={{ color: "var(--red)" }}>Off-Schedule</strong> — they checked in on a day
              their team&apos;s roster explicitly marks as an Off Day.
            </li>
            <li>Flags refresh automatically overnight, or on demand via &quot;Run anomaly sweep&quot; (Admin only).</li>
          </ul>
        </details>

        {/* Desktop table */}
        <div className="card p-4 overflow-x-auto hidden sm:block">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line2)" }}>
                {["Officer", "Station / Team", "Date", "Check In", "Check Out", "Total Hours", ""].map((h) => (
                  <th key={h} className="text-left p-2 t-mono text-[10px]" style={{ color: "var(--faint)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AttendanceRowDesktop key={r.id} row={r} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-sm" style={{ color: "var(--soft)" }}>
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
            <p className="text-sm text-center py-4" style={{ color: "var(--soft)" }}>
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
      {row.is_no_show && <Pill color="var(--red)">NO-SHOW</Pill>}
      {row.is_missing_checkout && <Pill color="var(--red)">MISSING CHECKOUT</Pill>}
      {row.is_off_schedule && <Pill color="var(--gold)">OFF-SCHEDULE</Pill>}
      {row.ot_minutes != null && (
        row.ot_request_id ? (
          <Link href={`/duty/overtime/${row.ot_request_id}`}>
            <Pill color="var(--green)">+{formatHours(row.ot_minutes)} OT →</Pill>
          </Link>
        ) : (
          <Pill color="var(--green)">+{formatHours(row.ot_minutes)} OT (unclaimed)</Pill>
        )
      )}
    </>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="t-mono text-[8.5px] font-bold px-1.5 py-0.5 inline-block"
      style={{ letterSpacing: "0.06em", color, border: `1px solid ${color}` }}
    >
      {children}
    </span>
  );
}

function AttendanceRowDesktop({ row }: { row: AttendanceRow }) {
  return (
    <tr style={{ borderTop: "1px solid var(--line2)" }}>
      <td className="p-2 align-top">
        <div className="flex items-center gap-2">
          <span
            className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center t-mono text-[9.5px] font-bold"
            style={{ background: "var(--gold-fill)", color: "var(--on-gold)" }}
          >
            {initials(row.staff_name)}
          </span>
          <div>
            <p className="font-semibold text-[12.5px]" style={{ color: "var(--ink2)" }}>
              {row.staff_name}
            </p>
            <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
              {row.staff_no}
            </p>
          </div>
        </div>
      </td>
      <td className="p-2 align-top t-mono text-[11px]" style={{ color: "var(--ink3)" }}>
        {row.station}
        <br />
        {row.team || "—"}
      </td>
      <td className="p-2 align-top t-mono text-[11px]" style={{ color: "var(--ink3)" }}>
        {formatDateMY(row.duty_date)}
      </td>
      <td className="p-2 align-top t-mono text-[11px]" style={{ color: "var(--ink3)" }}>
        {formatTimeMY(row.check_in_at)}
      </td>
      <td className="p-2 align-top t-mono text-[11px]" style={{ color: "var(--ink3)" }}>
        {row.is_missing_checkout ? <span style={{ color: "var(--red)" }}>Missing</span> : formatTimeMY(row.check_out_at)}
      </td>
      <td className="p-2 align-top t-mono text-[11px] font-semibold" style={{ color: "var(--ink)" }}>
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
          <span
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center t-mono text-[10px] font-bold"
            style={{ background: "var(--gold-fill)", color: "var(--on-gold)" }}
          >
            {initials(row.staff_name)}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-[13px] truncate" style={{ color: "var(--ink2)" }}>
              {row.staff_name}
            </p>
            <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
              {row.staff_no} · {row.station} · {row.team || "—"}
            </p>
          </div>
        </div>
        <p className="t-mono text-[10.5px] shrink-0" style={{ color: "var(--soft)" }}>
          {formatDateMY(row.duty_date)}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="field-hint mb-0">Check In</p>
          <p className="t-mono text-[11.5px] font-semibold">{formatTimeMY(row.check_in_at)}</p>
        </div>
        <div>
          <p className="field-hint mb-0">Check Out</p>
          <p className="t-mono text-[11.5px] font-semibold" style={row.is_missing_checkout ? { color: "var(--red)" } : undefined}>
            {row.is_missing_checkout ? "Missing" : formatTimeMY(row.check_out_at)}
          </p>
        </div>
        <div>
          <p className="field-hint mb-0">Total</p>
          <p className="t-mono text-[11.5px] font-semibold">{row.is_missing_checkout ? "—" : formatHours(row.total_minutes)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <StatusPills row={row} />
      </div>
    </div>
  );
}
