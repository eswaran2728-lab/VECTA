"use client";

import { useState } from "react";
import { createShift } from "@/lib/avsec/duty/roster-actions";

const QUICK_PRESETS = [
  { label: "Morning", start: "07:00", end: "15:00" },
  { label: "Afternoon", start: "15:00", end: "23:00" },
  { label: "Night", start: "23:00", end: "07:00" },
];

const DEFAULT_COLOR = "#c9a13a";

/** "Create Schedule" — builds a new named, reusable shift preset. The quick-fill buttons
 * are pure client-side convenience (just populate the time fields); what actually gets
 * saved is whatever ends up in the Name/Start/End/Off-day fields when Save is pressed. */
export function CreateScheduleForm() {
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [isOff, setIsOff] = useState(false);
  const [color, setColor] = useState(DEFAULT_COLOR);

  function applyPreset(preset: (typeof QUICK_PRESETS)[number]) {
    setIsOff(false);
    setName((n) => n || preset.label);
    setStart(preset.start);
    setEnd(preset.end);
  }

  function applyOffPreset() {
    setIsOff(true);
    setName((n) => n || "Off day");
    setStart("");
    setEnd("");
  }

  return (
    <form action={createShift} className="space-y-3">
      <div>
        <p className="field-label">Quick fill (optional — just fills the fields below)</p>
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          {QUICK_PRESETS.map((p) => (
            <button key={p.label} type="button" className="btn-quiet" onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
          <button type="button" className="btn-quiet" onClick={applyOffPreset}>
            Off day
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <div>
          <label className="field-label">Schedule name</label>
          <input
            type="text"
            name="label"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Morning A"
            className="input-base"
          />
        </div>
        <div>
          <label className="field-label">Color</label>
          <input
            type="color"
            name="color_hex"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="input-base p-1 h-[42px] w-[52px]"
          />
        </div>
      </div>

      {!isOff && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Start</label>
            <input
              type="time"
              name="start_time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required={!isOff}
              className="input-base"
            />
          </div>
          <div>
            <label className="field-label">End</label>
            <input
              type="time"
              name="end_time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required={!isOff}
              className="input-base"
            />
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--soft)" }}>
        <input
          type="checkbox"
          name="is_off"
          checked={isOff}
          onChange={(e) => {
            setIsOff(e.target.checked);
            if (e.target.checked) {
              setStart("");
              setEnd("");
            }
          }}
        />
        This is an off-day / no-shift schedule
      </label>

      <button type="submit" className="btn-primary">
        Save schedule
      </button>
    </form>
  );
}
