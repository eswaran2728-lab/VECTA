import { requireProfile } from "@/lib/avsec/auth";
import { getShifts } from "@/lib/avsec/duty/roster-queries";
import { getRosterForDate, getSuggestedOvertimeShifts } from "@/lib/avsec/duty/overtime-queries";
import { submitOvertimeRequest } from "@/lib/avsec/duty/overtime-actions";
import { OT_CATEGORIES } from "@/lib/avsec/schemas/duty";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { BottomNav } from "@/components/avsec/layout/BottomNav";
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
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Request Overtime" backHref="/avsec/duty/overtime" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        <form method="get" className="card p-4 space-y-3">
          <div>
            <label className="field-label">Work date</label>
            <input type="date" name="date" defaultValue={workDate} className="input-base" />
          </div>

          {suggestions.length > 0 && (
            <div>
              <label className="field-label">Link a completed shift (optional)</label>
              <select name="linked" defaultValue={searchParams.linked ?? ""} className="input-base">
                <option value="">— None, enter times manually —</option>
                {suggestions.map((s) => (
                  <option key={s.duty_id} value={s.duty_id}>
                    {s.duty_date} · {s.shift_code} · suggests {s.suggested_hours}h OT
                  </option>
                ))}
              </select>
            </div>
          )}

          <button type="submit" className="btn-secondary">
            Continue
          </button>
        </form>

        <form action={submitOvertimeRequest} className="card p-4 space-y-3">
          <input type="hidden" name="work_date" value={workDate} />
          <input type="hidden" name="linked_duty_id" value={linkedShift?.duty_id ?? ""} />

          <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
            OT date: {workDate}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Start</label>
              <input
                type="datetime-local"
                name="start_at"
                required
                defaultValue={linkedShift ? toLocalInputValue(linkedShift.scheduled_end) : ""}
                className="input-base"
              />
            </div>
            <div>
              <label className="field-label">End</label>
              <input
                type="datetime-local"
                name="end_at"
                required
                defaultValue={linkedShift ? toLocalInputValue(linkedShift.check_out_at) : ""}
                className="input-base"
              />
            </div>
          </div>

          {shifts.length > 0 && (
            <div>
              <label className="field-label">Shift (optional)</label>
              <select name="shift_code" defaultValue={linkedShift?.shift_code ?? roster?.shift_code ?? ""} className="input-base">
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
            <label className="field-label">Category</label>
            <select name="category" defaultValue={defaultCategory} className="input-base">
              {OT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {roster?.shift_code === "OFF" && (
              <p className="field-hint">This date is a rostered OFF day — off_day_work suggested.</p>
            )}
          </div>

          <div>
            <label className="field-label">Reason</label>
            <textarea name="reason" rows={3} required className="input-base" placeholder="Explain the overtime…" />
            <RemarkQuickPhrasesField phrases={OT_PHRASES} />
          </div>

          <button type="submit" className="btn-primary w-full">
            Submit request
          </button>
        </form>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}

// Server-rendered forms can't wire a controlled textarea to the quick-phrase buttons
// (that needs client state), so this stays a plain static hint list instead of the
// interactive RemarkQuickPhrases used in client components like CheckInScreen.
function RemarkQuickPhrasesField({ phrases }: { phrases: string[] }) {
  return (
    <p className="t-mono text-[9.5px] mt-2" style={{ color: "var(--faint)" }}>
      Suggestions: {phrases.join(" · ")}
    </p>
  );
}
