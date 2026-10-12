"use client";

import { useState, useTransition } from "react";
import {
  deactivateEntityAssignment,
  reassignEntityAssignment,
  requestCrossEntityTransfer,
  type AssignmentOptions,
  type EntityStaffRow,
} from "@/lib/avsec/admin/entity-staff";
import { firstMissingScopeField, requiredScopeFields, type ScopeField } from "@/lib/avsec/admin/registration-scope";

const FIELD_LABEL: Record<ScopeField, string> = { department: "Department", unit: "Unit", hub: "Hub", station: "Station", team: "Team" };

function StaffCard({ row, options, entityCode }: { row: EntityStaffRow; options: AssignmentOptions; entityCode: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [role, setRole] = useState(row.roleCode);
  const [sel, setSel] = useState<Record<ScopeField, string>>({ department: "", unit: "", hub: "", station: "", team: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const otherEntity = entityCode === "MAA" ? "AAX" : "MAA";
  const required = requiredScopeFields(role);

  const run = (fn: () => Promise<{ ok: boolean; error: string | null }>) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      setMessage(res.ok ? "Done. Refresh to see the change." : (res.error ?? "Refused."));
    });

  const reassign = () => {
    const missing = firstMissingScopeField(role, { departmentId: sel.department, unitId: sel.unit, hubId: sel.hub, stationId: sel.station, teamId: sel.team });
    if (missing) return setMessage(`${FIELD_LABEL[missing]} is required for this role.`);
    run(() =>
      reassignEntityAssignment({
        assignmentId: row.assignmentId,
        roleCode: role,
        departmentId: sel.department || null,
        unitId: sel.unit || null,
        hubId: sel.hub || null,
        stationId: sel.station || null,
        teamId: sel.team || null,
        reason,
      }),
    );
  };

  const field = (f: ScopeField, items: Array<{ id: string; label: string }>) =>
    !required || !required.includes(f) ? null : (
      <label key={f} className="space-y-1 text-xs">
        <span className="font-mono text-muted-foreground">{FIELD_LABEL[f]} *</span>
        <select
          value={sel[f]}
          onChange={(e) => {
            const v = e.target.value;
            setSel((p) => ({ ...p, [f]: v, ...(f === "department" ? { unit: "" } : {}), ...(f === "hub" ? { station: "", team: "" } : {}), ...(f === "station" ? { team: "" } : {}) }));
          }}
          className="input-base w-full"
        >
          <option value="">Select…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {row.staffName} <span className="font-mono text-xs text-muted-foreground">({row.staffNo})</span>
            {row.isSelf ? <span className="ml-2 font-mono text-[10px] text-muted-foreground">you</span> : null}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {row.roleCode} · {[row.departmentCode, row.unitCode, row.hubCode, row.stationCode, row.teamName].filter(Boolean).join(" / ") || "no scope"}
          </p>
        </div>
        {row.isSelf ? (
          <span className="font-mono text-[11px] text-muted-foreground">Your own assignment cannot be changed here.</span>
        ) : (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="btn-secondary min-h-[44px] px-4 text-xs">
            {open ? "Close" : "Manage"}
          </button>
        )}
      </div>
      {open && !row.isSelf && (
        <div className="space-y-3 border-t border-border pt-3">
          <label className="block space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Reason (required for every change)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="input-base w-full" maxLength={300} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={() => run(() => deactivateEntityAssignment(row.assignmentId, reason))} className="btn-secondary min-h-[44px] px-4 text-xs">
              Deactivate assignment
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => requestCrossEntityTransfer(row.assignmentId, otherEntity as "MAA" | "AAX", reason))} className="btn-secondary min-h-[44px] px-4 text-xs">
              Request transfer to {otherEntity}
            </button>
          </div>
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 font-mono text-[11px] text-muted-foreground">Reassign within {entityCode}</legend>
            <label className="block space-y-1 text-xs">
              <span className="font-mono text-muted-foreground">Role *</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="input-base w-full">
                {options.roles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field("department", options.departments.map((d) => ({ id: d.id, label: d.name })))}
              {field("unit", options.units.filter((u) => !sel.department || u.department_id === sel.department).map((u) => ({ id: u.id, label: u.name })))}
              {field("hub", options.hubs.map((h) => ({ id: h.id, label: h.name })))}
              {field("station", options.stations.filter((s) => !sel.hub || s.hub_id === sel.hub).map((s) => ({ id: s.id, label: `${s.code} — ${s.name}` })))}
              {field("team", options.teams.filter((t) => !sel.station || t.station_id === sel.station).map((t) => ({ id: t.id, label: t.name })))}
            </div>
            <button type="button" disabled={pending} onClick={reassign} className="btn-primary min-h-[44px] px-4 text-xs">
              Reassign
            </button>
          </fieldset>
        </div>
      )}
      {message ? (
        <p className="font-mono text-[11px] text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function EntityStaffManager({ rows, options, entityCode }: { rows: EntityStaffRow[]; options: AssignmentOptions; entityCode: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        No staff match.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <StaffCard key={r.assignmentId} row={r} options={options} entityCode={entityCode} />
      ))}
    </div>
  );
}
