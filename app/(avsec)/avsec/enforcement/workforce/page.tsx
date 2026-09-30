import { requirePhase8Role } from "@/lib/phase8/auth";
import {
  listEnforcementWorkforceSecure,
  listEnforcementAttendanceExceptionsSecure,
  listEnforcementPendingActionsSecure,
} from "@/lib/phase8/workforce";
import { EnforcementLeaveDecisionControls } from "@/components/avsec/enforcement/EnforcementLeaveDecisionControls";
import { ExportWorkforceButton } from "@/components/avsec/phase8/ExportWorkforceButton";
import { exportEnforcementWorkforce } from "@/lib/phase8/exports";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function MainEnforcementWorkforcePage() {
  await requirePhase8Role(["main_enforcement"]);

  const [workforceResult, exceptionsResult, pendingResult] = await Promise.all([
    listEnforcementWorkforceSecure(),
    listEnforcementAttendanceExceptionsSecure(),
    listEnforcementPendingActionsSecure(),
  ]);

  const workforce = workforceResult.data ?? [];
  const exceptions = exceptionsResult.data ?? [];
  const pending = pendingResult.data ?? [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold font-display">Main Enforcement Workspace</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Malaysia-wide workforce authority for Investigation, SAT and Profiling. Every action
            here is scoped strictly to the Enforcement department and independently authorized
            and audited at the database layer.
          </p>
        </div>

        {(workforceResult.error || exceptionsResult.error || pendingResult.error) && (
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">
            {workforceResult.error || exceptionsResult.error || pendingResult.error}
          </div>
        )}

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Pending Enforcement Decisions ({pending.length})
          </h2>
          {pending.length === 0 && (
            <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
              No pending Enforcement leave or overtime decisions.
            </div>
          )}
          {pending.map((item) => (
            <div key={`${item.kind}-${item.record_id}`} className="card p-4 space-y-2 border-border/80 bg-surface/80">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {item.kind === "leave" ? "Leave Request" : "Overtime Request"}
                  </p>
                  <p className="font-semibold text-sm text-foreground">{item.staff_name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{item.detail}</p>
                </div>
                <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">
                  {formatDateTimeMY(item.submitted_at)}
                </span>
              </div>
              {item.kind === "leave" && <EnforcementLeaveDecisionControls noticeId={item.record_id} staffName={item.staff_name} />}
              {item.kind === "overtime" && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  Review from the overtime request detail page (Enforcement-department OT final
                  approval is authorized for Main Enforcement at the database layer).
                </p>
              )}
            </div>
          ))}
        </section>

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Attendance Exceptions, Last 7 Days ({exceptions.length})
          </h2>
          {exceptions.length === 0 && (
            <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
              No attendance exceptions recorded for Enforcement staff.
            </div>
          )}
          {exceptions.map((ex) => (
            <div key={`${ex.profile_id}-${ex.duty_date}-${ex.shift_code}`} className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80">
              <div className="min-w-0">
                <p className="font-semibold text-sm text-foreground">{ex.staff_name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {ex.status.toUpperCase()} · {ex.shift_code}
                  {ex.late_remark ? ` · ${ex.late_remark}` : ""}
                </p>
              </div>
              <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">{formatDateMY(ex.duty_date)}</span>
            </div>
          ))}
        </section>

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Enforcement Workforce ({workforce.length})
          </h2>
          <ExportWorkforceButton label="Enforcement Workforce" action={exportEnforcementWorkforce} />
          {workforce.length === 0 && (
            <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
              No active Enforcement-department role assignments found.
            </div>
          )}
          {workforce.map((w) => (
            <div key={w.profile_id} className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80">
              <div className="min-w-0">
                <p className="font-semibold text-sm text-foreground">{w.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {w.role_code} {w.unit_code ? `· ${w.unit_code}` : ""} {w.staff_no ? `· ${w.staff_no}` : ""}
                </p>
              </div>
              <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">{w.status}</span>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
