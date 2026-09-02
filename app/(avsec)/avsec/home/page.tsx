import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { getOverdueAircraft, getMySubmissions } from "@/lib/avsec/reports/queries";
import { getTodayRoster, getTodayDutyRecord } from "@/lib/avsec/duty/checkin-queries";
import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";
import { formatTimeMY, nowTimeMY } from "@/lib/avsec/datetime";

const REPORT_ORDER: ReportType[] = ["sec016", "sec014", "sec029", "sec018", "sec033", "sec013", "offload"];
const RED_ACCENT: Partial<Record<ReportType, true>> = { sec029: true, sec033: true };

function shortLabel(type: ReportType) {
  if (type === "offload") return "OFL";
  return type.slice(0, 3).toUpperCase() + " " + type.slice(3);
}

function greeting() {
  const hour = Number(nowTimeMY().split(":")[0]);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const profile = await requireRole(["ASO"]);
  const [overdue, recent, roster] = await Promise.all([
    profile.station ? getOverdueAircraft(profile.station) : Promise.resolve([]),
    getMySubmissions({ profileId: profile.id, limit: 5 }),
    profile.station ? getTodayRoster(profile.station, profile.team ?? "") : Promise.resolve(null),
  ]);
  const dutyRecord = roster ? await getTodayDutyRecord(profile.id, roster.shift_code) : null;
  const firstName = profile.name.split(" ")[0] || profile.name;

  const dutyStatusLabel = dutyRecord?.check_out_at
    ? "Shift complete"
    : dutyRecord?.check_in_at
      ? `On duty since ${formatTimeMY(dutyRecord.check_in_at)}`
      : "Not checked in";

  return (
    <main className="min-h-screen pb-32">

      <div className="max-w-3xl mx-auto px-4 py-5 space-y-6">
        <div>
          <h1 className="t-display text-2xl">
            {greeting()}, <span style={{ color: "var(--gold)" }}>{firstName}</span>
          </h1>
          <p className="text-[13px] mt-1.5" style={{ color: "var(--soft)" }}>
            {profile.role} · {profile.team ? `Team ${profile.team}` : profile.station}
          </p>
        </div>

        <Link
          href="/avsec/duty"
          className="flex items-center justify-between gap-3 p-4"
          style={{ background: "var(--panel)", border: "1px solid var(--line)", borderLeft: "3px solid var(--gold)" }}
        >
          <div>
            <p className="t-mono text-[10px] font-semibold" style={{ letterSpacing: "0.12em", color: "var(--soft)" }}>
              DUTY CHECK-IN
            </p>
            <p className="text-[14px] font-semibold mt-1" style={{ color: "var(--ink)" }}>
              {dutyStatusLabel}
            </p>
          </div>
          <span className="t-mono text-[13px] shrink-0" style={{ color: "var(--faintest)" }}>
            ›
          </span>
        </Link>

        {overdue.length > 0 && (
          <section className="p-4" style={{ background: "var(--red-panel)", borderLeft: "3px solid var(--red)" }}>
            <h2 className="t-mono text-[11px] font-bold" style={{ letterSpacing: "0.1em", color: "var(--red)" }}>
              ⚠ {overdue.length} aircraft overdue for search (SEC 029)
            </h2>
            <ul className="space-y-1 text-[12.5px] mt-2" style={{ color: "var(--red-ink)" }}>
              {overdue.map((a) => (
                <li key={a.id}>
                  Reg <span className="font-semibold">{a.reg_no}</span> · Bay {a.bay} ·{" "}
                  {a.hoursOnGround.toFixed(1)}h on ground
                </li>
              ))}
            </ul>
            <Link href="/avsec/bay-board" className="btn-quiet mt-1 inline-block">
              Open Bay Board →
            </Link>
          </section>
        )}

        <section>
          <h2 className="t-mono text-[11px] font-semibold mb-2.5" style={{ letterSpacing: "0.24em", color: "var(--ink)" }}>
            New report
          </h2>
          <div className="flex flex-col gap-2">
            {REPORT_ORDER.map((type) => {
              const meta = REPORT_META[type];
              const accent = RED_ACCENT[type] ? "var(--red)" : "var(--gold)";
              return (
                <Link
                  key={type}
                  href={`/avsec/reports/${type}`}
                  className="flex items-center gap-3 p-3.5 transition-colors"
                  style={{ background: "var(--panel)", border: "1px solid var(--line)", borderLeft: `3px solid ${accent}` }}
                >
                  <span className="w-11 shrink-0 t-display text-[15px] leading-none" style={{ color: accent }}>
                    {shortLabel(type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[13.5px]" style={{ color: "var(--ink2)" }}>
                      {meta.name}
                    </p>
                    <p className="t-mono text-[9.5px] mt-[3px]" style={{ color: "var(--soft)" }}>
                      {meta.code}
                    </p>
                  </div>
                  <span className="t-mono text-[13px] shrink-0" style={{ color: "var(--faintest)" }}>
                    ›
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

        <section className="flex items-baseline justify-between">
          <h2 className="t-mono text-[11px] font-semibold" style={{ letterSpacing: "0.24em", color: "var(--ink)" }}>
            My submissions
          </h2>
          <Link href="/avsec/history" className="btn-quiet">
            View all →
          </Link>
        </section>

        <section>
          {recent.length === 0 && (
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              No submissions yet. Your submitted reports will appear here.
            </p>
          )}
          <div>
            {recent.map((r) => (
              <Link
                key={`${r.type}-${r.id}`}
                href={`/avsec/reports/view/${r.type}/${r.id}`}
                className="grid grid-cols-[46px_1fr] gap-3 pb-4"
              >
                <p className="t-mono text-[11px] pt-[1px]" style={{ color: "var(--mid)" }}>
                  {formatTimeMY(r.submitted_at ?? r.created_at)}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span
                    className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                    style={{ background: RED_ACCENT[r.type] ? "var(--red)" : "var(--gold-fill)" }}
                  />
                  <p className="font-semibold text-[13.5px]" style={{ color: "var(--ink2)" }}>
                    {shortLabel(r.type)} · {REPORT_META[r.type].name}
                  </p>
                  <p className="t-mono text-[10.5px] mt-[3px]" style={{ color: "var(--soft)" }}>
                    {r.summary}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <Link href="/avsec/bay-board" className="btn-secondary w-full">
          Bay Board
        </Link>
      </div>
    </main>
  );
}
