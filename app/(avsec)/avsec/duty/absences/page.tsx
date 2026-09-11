import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { formatAbsenceGap } from "@/lib/avsec/duty/absence-logic";
import { getAbsenceNotices } from "@/lib/avsec/duty/absence-queries";
import { ROLE_LABELS, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";

export default async function StaffAbsenceHistoryPage() {
  const profile = await requireProfile();
  const isManagement = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const isDSE = profile.role === "DSE";

  // Fetch staff's own records
  const personalRecords = await getAbsenceNotices({
    userId: profile.id,
    limit: 50,
  });

  // If DSE, also fetch station/team records
  const teamRecords = isDSE
    ? await getAbsenceNotices({
        station: profile.station ?? undefined,
        team: profile.team ?? undefined,
        limit: 100,
      })
    : [];

  return (
    <main className="min-h-screen bg-background pb-32">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
          <div>
            <div className="font-mono text-xs font-semibold text-primary uppercase tracking-widest">
              Duty Ops · Compliance Tracking
            </div>
            <h1 className="font-display font-bold text-2xl text-foreground mt-0.5">
              Absence Notice Log
            </h1>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              Immutable server timestamps capturing advance notice before shift start.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/avsec/duty"
              className="btn btn-secondary text-xs px-3 py-1.5"
            >
              ← Back to Duty
            </Link>
            {isManagement && (
              <Link
                href="/avsec/admin/absences"
                className="btn btn-primary text-xs px-3 py-1.5"
              >
                Management View →
              </Link>
            )}
          </div>
        </div>

        {/* Policy notice */}
        <div className="card p-4 border-l-4 border-l-primary/60 bg-muted/20 space-y-1.5">
          <div className="font-mono text-xs font-bold text-foreground flex items-center gap-2">
            <span>ℹ️</span> Advance Notice Compliance Standard
          </div>
          <p className="font-mono text-xs text-muted-foreground leading-relaxed">
            • <strong className="text-emerald-500">Green (≥ 3 hours notice)</strong>: Compliant advance notice submitted before rostered shift start.<br />
            • <strong className="text-rose-500">Red (&lt; 3 hours notice or after start)</strong>: Late notice or post-shift notice.<br />
            All submissions record permanent server timestamps utilized for operational performance evaluations.
          </p>
        </div>

        {/* My Records */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-semibold text-base text-foreground flex items-center gap-2">
              <span>👤</span> My Absence Submissions ({personalRecords.length})
            </h2>
          </div>

          {personalRecords.length === 0 ? (
            <div className="card p-8 text-center space-y-2">
              <div className="text-3xl">✅</div>
              <div className="font-display font-semibold text-sm text-foreground">
                No absence records found
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                You have not submitted any late-notice absence reports.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {personalRecords.map((item) => {
                const isGreen = item.status === "green";
                return (
                  <div
                    key={item.id}
                    className={`card p-4 border-l-4 transition-all ${
                      isGreen
                        ? "border-l-emerald-500 bg-emerald-500/5 hover:border-l-emerald-400"
                        : "border-l-rose-500 bg-rose-500/5 hover:border-l-rose-400"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`font-mono text-xs px-2 py-0.5 rounded-full font-bold uppercase ${
                            isGreen
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {isGreen ? "🟢 Compliant Notice" : "🔴 Late Notice"}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          Shift: {item.duty_date} · {item.shift_start_time?.slice(0, 5) || "08:00"} ({item.shift_code || "ROSTER"})
                        </span>
                      </div>

                      <div className="font-mono text-xs font-semibold text-foreground">
                        {formatAbsenceGap(item.gap_minutes)}
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="font-mono text-xs text-muted-foreground">
                        <strong className="text-foreground">Submitted:</strong>{" "}
                        {new Date(item.submitted_at).toLocaleString("en-MY", {
                          timeZone: "Asia/Kuala_Lumpur",
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </div>

                      <div className="p-2.5 rounded-lg bg-background/60 border border-border/50 text-xs font-sans text-foreground">
                        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">
                          Remarks / Reason for absence:
                        </div>
                        {item.remarks}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* DSE Team Feed if applicable */}
        {isDSE && (
          <section className="space-y-3 pt-6 border-t border-border">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display font-semibold text-base text-foreground flex items-center gap-2">
                  <span>🏢</span> Station / Team Submissions ({profile.station || "All"} · Team {profile.team || "All"})
                </h2>
                <p className="font-mono text-xs text-muted-foreground">
                  Live feed of absence notices submitted by duty officers in your scope.
                </p>
              </div>
              <span className="font-mono text-xs text-primary font-bold">
                {teamRecords.length} records
              </span>
            </div>

            {teamRecords.length === 0 ? (
              <div className="card p-6 text-center font-mono text-xs text-muted-foreground">
                No recent absence notices in your station/team.
              </div>
            ) : (
              <div className="space-y-3">
                {teamRecords.map((item) => {
                  const isGreen = item.status === "green";
                  return (
                    <div
                      key={item.id}
                      className={`card p-4 border-l-4 ${
                        isGreen
                          ? "border-l-emerald-500 bg-emerald-500/5"
                          : "border-l-rose-500 bg-rose-500/5"
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-2">
                        <div>
                          <span className="font-display font-bold text-sm text-foreground">
                            {item.staff_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground ml-2">
                            {ROLE_LABELS[item.role] || item.role} · {item.staff_id || "—"}
                          </span>
                        </div>
                        <span
                          className={`font-mono text-xs px-2 py-0.5 rounded font-bold ${
                            isGreen
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {formatAbsenceGap(item.gap_minutes)}
                        </span>
                      </div>

                      <div className="mt-2 text-xs font-mono text-muted-foreground">
                        <span>Duty: {item.duty_date} (Start: {item.shift_start_time?.slice(0, 5)})</span> ·{" "}
                        <span>Submitted: {new Date(item.submitted_at).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                      </div>

                      <div className="mt-2 p-2 rounded bg-background/60 border border-border/50 text-xs text-foreground">
                        {item.remarks}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
