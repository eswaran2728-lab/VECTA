import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getShifts } from "@/lib/avsec/duty/roster-queries";
import { getRosterForDate, getSuggestedOvertimeShifts } from "@/lib/avsec/duty/overtime-queries";
import { submitOvertimeRequest } from "@/lib/avsec/duty/overtime-actions";
import { OT_CATEGORIES } from "@/lib/avsec/schemas/duty";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { todayISODateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

const OT_PHRASES = ["Flight delay", "Manpower shortage", "Event coverage", "Ad-hoc operational requirement"];

function toLocalInputValue(iso: string): string {
  return formatDateTimeMY(iso, "yyyy-MM-dd'T'HH:mm");
}

export default async function NewOvertimeRequestPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ date?: string; linked?: string; error?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const workDate = searchParams.date || todayISODateMY();

  const [shifts, roster, suggestions] = await Promise.all([
    getShifts(),
    profile.station ? getRosterForDate(profile.station, profile.team ?? "", workDate) : Promise.resolve(null),
    profile.station
      ? getSuggestedOvertimeShifts(profile.id, profile.station, profile.team ?? "")
      : Promise.resolve([]),
  ]);

  const linkedShift = suggestions.find((s) => s.duty_id === searchParams.linked) ?? null;
  const defaultCategory = roster?.shift_code === "OFF" ? "off_day_work" : "adhoc";

  return (
    <main className="dark min-h-screen bg-background pb-28">
      <div className="flex items-center gap-3 border-b border-border px-6 py-[18px]">
        <Link
          href="/avsec/duty/overtime"
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center font-mono text-base text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr;
        </Link>
        <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
          REQUEST OVERTIME
        </span>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        {searchParams.error && (
          <div className="vecta-panel border-brand/40 bg-brand/10 px-5 py-4 text-sm font-medium text-brand">
            {searchParams.error}
          </div>
        )}

        <form method="get" className="vecta-panel space-y-3 !py-4">
          <div>
            <label className="vecta-label">Work date</label>
            <input type="date" name="date" defaultValue={workDate} className="vecta-input" />
          </div>

          {suggestions.length > 0 && (
            <div>
              <label className="vecta-label">Link a completed shift (optional)</label>
              <select name="linked" defaultValue={searchParams.linked ?? ""} className="vecta-input">
                <option value="">— None, enter times manually —</option>
                {suggestions.map((s) => (
                  <option key={s.duty_id} value={s.duty_id}>
                    {s.duty_date} · {s.shift_code} · suggests {s.suggested_hours}h OT
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="submit"
            className="rounded-full border border-border px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            Continue
          </button>
        </form>

        <form action={submitOvertimeRequest} className="vecta-panel space-y-3 !py-4">
          <input type="hidden" name="work_date" value={workDate} />
          <input type="hidden" name="linked_duty_id" value={linkedShift?.duty_id ?? ""} />

          <p className="font-mono text-[10px] text-muted-foreground">OT date: {workDate}</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="vecta-label">Start</label>
              <input
                type="datetime-local"
                name="start_at"
                required
                defaultValue={linkedShift ? toLocalInputValue(linkedShift.scheduled_end) : ""}
                className="vecta-input"
              />
            </div>
            <div>
              <label className="vecta-label">End</label>
              <input
                type="datetime-local"
                name="end_at"
                required
                defaultValue={linkedShift ? toLocalInputValue(linkedShift.check_out_at) : ""}
                className="vecta-input"
              />
            </div>
          </div>

          {shifts.length > 0 && (
            <div>
              <label className="vecta-label">Shift (optional)</label>
              <select name="shift_code" defaultValue={linkedShift?.shift_code ?? roster?.shift_code ?? ""} className="vecta-input">
                <option value="">—</option>
                {shifts.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="vecta-label">Category</label>
            <select name="category" defaultValue={defaultCategory} className="vecta-input">
              {OT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {roster?.shift_code === "OFF" && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                This date is a rostered OFF day — off_day_work suggested.
              </p>
            )}
          </div>

          <div>
            <label className="vecta-label">Reason</label>
            <textarea name="reason" rows={3} required className="vecta-input h-auto py-2.5" placeholder="Explain the overtime…" />
            <RemarkQuickPhrasesField phrases={OT_PHRASES} />
          </div>

          <button type="submit" className="vecta-btn-primary w-full">
            Submit request
          </button>
        </form>
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} />
    </main>
  );
}

// Server-rendered forms can't wire a controlled textarea to the quick-phrase buttons
// (that needs client state), so this stays a plain static hint list instead of the
// interactive RemarkQuickPhrases used in client components like CheckInScreen.
function RemarkQuickPhrasesField({ phrases }: { phrases: string[] }) {
  return (
    <p className="mt-2 font-mono text-[9.5px] text-muted-foreground">Suggestions: {phrases.join(" · ")}</p>
  );
}
