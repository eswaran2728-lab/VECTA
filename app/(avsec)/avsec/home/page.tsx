import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { getAllowedReportForms } from "@/lib/avsec/reports/form-capability";
import { getOverdueAircraft, getMySubmissions } from "@/lib/avsec/reports/queries";
import { getTodayRoster, getTodayDutyRecord } from "@/lib/avsec/duty/checkin-queries";
import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";
import { getActiveAnnouncementsForUser } from "@/lib/avsec/announcements/queries";
import { ReportCategoryGroups } from "@/components/avsec/reports/ReportCategoryGroups";
import { AnnouncementBanner } from "@/components/avsec/announcements/AnnouncementBanner";
import { formatTimeMY, nowTimeMY } from "@/lib/avsec/datetime";

const RED_ACCENT: Partial<Record<ReportType, true>> = { sec029: true, sec033: true };

function shortLabel(type: ReportType) {
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
  const allowedForms = await getAllowedReportForms();
  const [overdue, recent, roster, announcements] = await Promise.all([
    profile.station ? getOverdueAircraft(profile.station) : Promise.resolve([]),
    getMySubmissions({ profileId: profile.id, limit: 5 }),
    profile.station ? getTodayRoster(profile.station, profile.team ?? "") : Promise.resolve(null),
    getActiveAnnouncementsForUser(profile),
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
          <h1 className="font-display text-2xl font-bold tracking-[0.03em] text-foreground">
            {greeting()}, <span className="text-primary">{firstName}</span>
          </h1>
          <p className="font-mono text-xs text-muted-foreground mt-1 tracking-wider uppercase">
            {(profile.role === "ADMIN" ? "MANAGEMENT" : profile.role)} · {profile.team ? `Team ${profile.team}` : profile.station}
          </p>
        </div>

        {/* Management Announcements Section */}
        <AnnouncementBanner announcements={announcements} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            href="/avsec/duty"
            className="flex items-center justify-between gap-3 p-4 rounded-xl border border-border bg-card border-l-4 border-l-primary hover:border-primary/80 transition-colors group"
          >
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
                DUTY CHECK-IN
              </p>
              <p className="text-[14px] font-semibold text-foreground mt-1">
                {dutyStatusLabel}
              </p>
            </div>
            <span className="font-mono text-sm text-muted-foreground group-hover:text-primary transition-colors shrink-0">
              →
            </span>
          </Link>

        </div>

        {overdue.length > 0 && (
          <section className="p-4 rounded-xl border border-destructive/40 bg-destructive/10 border-l-4 border-l-destructive">
            <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-destructive">
              ⚠ {overdue.length} aircraft overdue for search (SEC 029)
            </h2>
            <ul className="space-y-1 text-xs mt-2 text-foreground font-mono">
              {overdue.map((a) => (
                <li key={a.id}>
                  Reg <span className="font-bold text-foreground">{a.reg_no}</span> · Bay {a.bay} ·{" "}
                  {a.hoursOnGround.toFixed(1)}h on ground
                </li>
              ))}
            </ul>
            <Link href="/avsec/bay-board" className="btn-quiet mt-2 inline-block text-foreground underline underline-offset-2">
              Open Bay Board →
            </Link>
          </section>
        )}

        <section>
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-3">
            New report
          </h2>
          <ReportCategoryGroups allowed={allowedForms} layout="list" />
        </section>

        <section className="flex items-baseline justify-between pt-2">
          <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            My submissions
          </h2>
          <Link href="/avsec/history" className="btn-quiet">
            View all →
          </Link>
        </section>

        <section>
          {recent.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No submissions yet. Your submitted reports will appear here.
            </p>
          )}
          <div className="space-y-3">
            {recent.map((r) => (
              <Link
                key={`${r.type}-${r.id}`}
                href={`/avsec/reports/view/${r.type}/${r.id}`}
                className="grid grid-cols-[54px_1fr] gap-3 pb-3 border-b border-border/50 group"
              >
                <p className="font-mono text-[11px] text-muted-foreground pt-0.5">
                  {formatTimeMY(r.submitted_at ?? r.created_at)}
                </p>
                <div className="relative pl-4 border-l border-border group-hover:border-primary transition-colors">
                  <span
                    className={`absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full ${
                      RED_ACCENT[r.type] ? "bg-destructive" : "bg-primary"
                    }`}
                  />
                  <p className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors">
                    {shortLabel(r.type)} · {REPORT_META[r.type].name}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground mt-0.5">
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
