"use client";

import { useState } from "react";
import type { Shift, RosterCell as RosterCellRow } from "@/lib/avsec/duty/roster-queries";
import { upsertRosterCell, clearRosterCell } from "@/lib/avsec/duty/roster-actions";
import { LEAVE_TYPE_ICONS, type LeaveType } from "@/lib/avsec/duty/absence-logic";

function hhmm(t: string | null | undefined) {
  return t ? t.slice(0, 5) : "";
}

export interface LeaveInfoProp {
  leaveType: LeaveType;
  leaveLabel: string;
}

export function RosterCell({
  station,
  team,
  date,
  week,
  shifts,
  cell,
  leaveInfo,
}: {
  station: string;
  team: string;
  date: string;
  week: string;
  shifts: Shift[];
  cell?: RosterCellRow;
  leaveInfo?: LeaveInfoProp;
}) {
  const [editing, setEditing] = useState(false);
  const [shiftCode, setShiftCode] = useState(cell?.shift_code ?? "");
  const [start, setStart] = useState(hhmm(cell?.start_time));
  const [end, setEnd] = useState(hhmm(cell?.end_time));

  function handleShiftChange(code: string) {
    setShiftCode(code);
    const preset = shifts.find((s) => s.code === code);
    if (preset) {
      setStart(hhmm(preset.default_start));
      setEnd(hhmm(preset.default_end));
    }
  }

  if (!editing) {
    const preset = shifts.find((s) => s.code === cell?.shift_code);
    const isWorkingShift = Boolean(cell?.shift_code && cell.shift_code.toUpperCase() !== "OFF");
    const hasConflict = Boolean(leaveInfo && isWorkingShift);

    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full min-h-[68px] p-2 text-left transition-colors flex flex-col justify-between"
        style={{
          background: hasConflict
            ? "rgba(244, 63, 94, 0.08)"
            : leaveInfo
              ? "rgba(245, 158, 11, 0.06)"
              : cell
                ? "var(--panel2)"
                : "transparent",
          border: hasConflict
            ? "1px solid rgba(244, 63, 94, 0.4)"
            : leaveInfo
              ? "1px solid rgba(245, 158, 11, 0.35)"
              : cell
                ? "1px solid var(--line)"
                : "1px dashed var(--line3)",
        }}
      >
        <div>
          {cell ? (
            <>
              <p className="t-mono text-[10px] font-semibold" style={{ color: "var(--gold)" }}>
                {preset?.label ?? cell.shift_code}
              </p>
              {(cell.start_time || cell.end_time) && (
                <p className="t-mono text-[9px] mt-0.5" style={{ color: "var(--soft)" }}>
                  {hhmm(cell.start_time)}–{hhmm(cell.end_time)}
                </p>
              )}
              {cell.notes && (
                <p className="text-[10px] mt-0.5 truncate" style={{ color: "var(--faint)" }}>
                  {cell.notes}
                </p>
              )}
            </>
          ) : (
            <p className="t-mono text-[10px]" style={{ color: "var(--faintest)" }}>
              + Set
            </p>
          )}
        </div>

        {/* Layered On-Leave Status & Conflict Warning */}
        {leaveInfo && (
          <div className="mt-1.5 space-y-1">
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[8.5px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              {LEAVE_TYPE_ICONS[leaveInfo.leaveType] || "🌴"} {leaveInfo.leaveLabel}
            </span>
            {hasConflict && (
              <span className="block font-mono text-[8px] font-bold text-rose-400">
                ⚠️ Reassignment Needed
              </span>
            )}
          </div>
        )}
      </button>
    );
  }

  return (
    <div className="p-2 space-y-1.5" style={{ background: "var(--panel2)", border: "1px solid var(--gold-fill)" }}>
      <form
        action={async (formData) => {
          await upsertRosterCell(formData);
          setEditing(false);
        }}
        className="space-y-1.5"
      >
        <input type="hidden" name="station" value={station} />
        <input type="hidden" name="team" value={team} />
        <input type="hidden" name="roster_date" value={date} />
        <input type="hidden" name="week" value={week} />

        {shiftCode !== "OFF" && (
          <div>
            <p className="t-mono text-[8.5px]" style={{ letterSpacing: "0.06em", color: "var(--soft)" }}>
              SHIFT TIMING (edit freely — picking a shift below just fills in its usual hours)
            </p>
            <div className="flex gap-1 mt-1">
              <div className="flex-1">
                <label className="t-mono text-[8px]" style={{ color: "var(--faint)" }}>
                  Start
                </label>
                <input
                  type="time"
                  name="start_time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="input-base py-1.5 min-h-0 text-[11px] w-full"
                />
              </div>
              <div className="flex-1">
                <label className="t-mono text-[8px]" style={{ color: "var(--faint)" }}>
                  End
                </label>
                <input
                  type="time"
                  name="end_time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="input-base py-1.5 min-h-0 text-[11px] w-full"
                />
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="t-mono text-[8px]" style={{ color: "var(--faint)" }}>
            Shift
          </label>
          <select
            name="shift_code"
            value={shiftCode}
            onChange={(e) => handleShiftChange(e.target.value)}
            className="input-base py-1.5 min-h-0 text-[11px] w-full"
            required
          >
            <option value="" disabled>
              Pick what they&apos;re working…
            </option>
            {shifts.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <input
          type="text"
          name="notes"
          defaultValue={cell?.notes ?? ""}
          placeholder="Notes (optional)"
          className="input-base py-1.5 min-h-0 text-[11px] w-full"
        />

        <div className="flex gap-1">
          <button type="submit" className="btn-primary py-1.5 min-h-0 text-[10px] flex-1">
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className="btn-secondary py-1.5 min-h-0 text-[10px]">
            Cancel
          </button>
        </div>
      </form>

      {cell && (
        <form
          action={async (formData) => {
            await clearRosterCell(formData);
            setEditing(false);
          }}
        >
          <input type="hidden" name="station" value={station} />
          <input type="hidden" name="team" value={team} />
          <input type="hidden" name="roster_date" value={date} />
          <button type="submit" className="t-mono text-[10px] w-full text-center py-1" style={{ color: "var(--red)" }}>
            Clear cell
          </button>
        </form>
      )}
    </div>
  );
}
