"use client";

import { useState } from "react";
import type { Shift, RosterCell as RosterCellRow } from "@/lib/duty/roster-queries";
import { upsertRosterCell, clearRosterCell } from "@/lib/duty/roster-actions";

function hhmm(t: string | null | undefined) {
  return t ? t.slice(0, 5) : "";
}

export function RosterCell({
  station,
  team,
  date,
  week,
  shifts,
  cell,
}: {
  station: string;
  team: string;
  date: string;
  week: string;
  shifts: Shift[];
  cell?: RosterCellRow;
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
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full min-h-[64px] p-2 text-left transition-colors"
        style={{
          background: cell ? "var(--panel2)" : "transparent",
          border: cell ? "1px solid var(--line)" : "1px dashed var(--line3)",
        }}
      >
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

        <select
          name="shift_code"
          value={shiftCode}
          onChange={(e) => handleShiftChange(e.target.value)}
          className="input-base py-1.5 min-h-0 text-[11px] w-full"
          required
        >
          <option value="" disabled>
            Shift…
          </option>
          {shifts.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>

        {shiftCode && shiftCode !== "OFF" && (
          <div>
            <p className="t-mono text-[8.5px]" style={{ letterSpacing: "0.06em", color: "var(--soft)" }}>
              EDIT TIMING (pre-filled from preset — change if this shift runs differently)
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
