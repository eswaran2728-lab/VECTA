"use client";

import { useState, useTransition } from "react";
import {
  approveEntityRegistration,
  getRegistrationAssignmentOptions,
  rejectEntityRegistration,
  type EntityRegistrationRequestRow,
  type RegistrationOptions,
} from "@/lib/avsec/admin/entity-registrations";
import { firstMissingScopeField, requiredScopeFields, type ScopeField } from "@/lib/avsec/admin/registration-scope";

/**
 * Entity-admin registration review. Selectors come from the authorized options RPC (never a typed UUID); the AOC and entity are
 * shown read-only and are fixed by the request. Which scope selectors appear -- and which are required -- follows the chosen role.
 * This is guidance only: approve_registration_request() and the scope trigger in the database make the real decision, and any
 * refusal is shown to the admin as an error.
 */
const FIELD_LABEL: Record<ScopeField, string> = { department: "Department", unit: "Unit", hub: "Hub", station: "Station", team: "Team" };

function RequestCard({ row, onDone }: { row: EntityRegistrationRequestRow; onDone: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RegistrationOptions | null>(null);
  const [role, setRole] = useState("");
  const [sel, setSel] = useState<Record<ScopeField, string>>({ department: "", unit: "", hub: "", station: "", team: "" });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !options) {
      startTransition(async () => {
        const res = await getRegistrationAssignmentOptions(row.id);
        if (!res.ok || !res.options) {
          setError(res.error ?? "Could not load the assignment options.");
          return;
        }
        setOptions(res.options);
        const o = res.options.request;
        const requested = res.options.roles.some((r) => r.code === o.requested_role_code) ? (o.requested_role_code ?? "") : "";
        setRole(requested);
        setSel({
          department: o.requested_department_id ?? "",
          unit: o.requested_unit_id ?? "",
          hub: o.requested_hub_id ?? "",
          station: o.requested_station_id ?? "",
          team: o.requested_team_id ?? "",
        });
      });
    }
  }

  const required = role ? requiredScopeFields(role) : null;
  const units = options?.units.filter((u) => !sel.department || u.department_id === sel.department) ?? [];
  const stations = options?.stations.filter((s) => !sel.hub || s.hub_id === sel.hub) ?? [];
  const teams = options?.teams.filter((t) => !sel.station || t.station_id === sel.station) ?? [];

  function approve() {
    setError(null);
    const missing = role
      ? firstMissingScopeField(role, { departmentId: sel.department, unitId: sel.unit, hubId: sel.hub, stationId: sel.station, teamId: sel.team })
      : null;
    if (!role) return setError("Choose a role first.");
    if (missing) return setError(`${FIELD_LABEL[missing]} is required for this role.`);
    const fd = new FormData();
    fd.set("requestId", row.id);
    fd.set("roleCode", role);
    fd.set("departmentId", sel.department);
    fd.set("unitId", sel.unit);
    fd.set("hubId", sel.hub);
    fd.set("stationId", sel.station);
    fd.set("teamId", sel.team);
    startTransition(async () => {
      const res = await approveEntityRegistration(fd);
      if (!res.ok) return setError(res.error ?? "The approval was refused.");
      onDone(row.id);
    });
  }

  function reject() {
    setError(null);
    if (reason.trim().length < 3) return setError("A rejection reason is required.");
    const fd = new FormData();
    fd.set("requestId", row.id);
    fd.set("reason", reason);
    startTransition(async () => {
      const res = await rejectEntityRegistration(fd);
      if (!res.ok) return setError(res.error ?? "The rejection was refused.");
      onDone(row.id);
    });
  }

  const select = (field: ScopeField, items: Array<{ id: string; label: string }>) => {
    const visible = !required || required.includes(field);
    if (!visible) return null;
    const isRequired = Boolean(required?.includes(field));
    return (
      <label key={field} className="space-y-1 text-xs">
        <span className="font-mono text-muted-foreground">
          {FIELD_LABEL[field]}
          {isRequired ? " *" : ""}
        </span>
        <select
          value={sel[field]}
          onChange={(e) => {
            const v = e.target.value;
            setSel((prev) => ({
              ...prev,
              [field]: v,
              ...(field === "department" ? { unit: "" } : {}),
              ...(field === "hub" ? { station: "", team: "" } : {}),
              ...(field === "station" ? { team: "" } : {}),
            }));
          }}
          required={isRequired}
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
  };

  return (
    <div className="card space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {row.staffName} <span className="font-mono text-xs text-muted-foreground">({row.staffNo})</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {row.operatingEntityCode} · requested {row.requestedRoleCode ?? "(unspecified)"}
            {row.requestedStationCode ? ` · ${row.requestedStationCode}` : ""}
            {row.requestedTeamName ? ` · Team ${row.requestedTeamName}` : ""} · {row.isTransfer ? "transfer · " : ""}submitted{" "}
            {new Date(row.submittedAt).toLocaleString()}
          </p>
          {row.applicantNotes ? <p className="text-xs text-muted-foreground">Notes: {row.applicantNotes}</p> : null}
        </div>
        <button type="button" onClick={toggle} aria-expanded={open} className="btn-secondary min-h-[44px] px-4 text-xs">
          {open ? "Close" : "Review"}
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border pt-3">
          {!options ? (
            <p className="font-mono text-xs text-muted-foreground" role="status">
              {pending ? "Loading options…" : (error ?? "")}
            </p>
          ) : (
            <>
              <p className="font-mono text-[11px] text-muted-foreground">
                AOC {options.request.aoc_code ?? "—"} · entity {options.request.entity_code} (fixed by the request)
              </p>
              <label className="block space-y-1 text-xs">
                <span className="font-mono text-muted-foreground">Role *</span>
                <select value={role} onChange={(e) => setRole(e.target.value)} className="input-base w-full" required>
                  <option value="">Select a role…</option>
                  {options.roles.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              {role && !required ? (
                <p className="font-mono text-xs text-amber-500" role="status">
                  This role has no self-service assignment form; the database will decide whether it can be assigned.
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {select("department", options.departments.map((d) => ({ id: d.id, label: d.name })))}
                {select("unit", units.map((u) => ({ id: u.id, label: u.name })))}
                {select("hub", options.hubs.map((h) => ({ id: h.id, label: h.name })))}
                {select("station", stations.map((s) => ({ id: s.id, label: `${s.code} — ${s.name}` })))}
                {select("team", teams.map((t) => ({ id: t.id, label: t.name })))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={approve} disabled={pending} className="btn-primary min-h-[44px] px-4 text-xs">
                  {pending ? "Working…" : "Approve"}
                </button>
              </div>
              <div className="space-y-2 border-t border-border pt-3">
                <label className="block space-y-1 text-xs">
                  <span className="font-mono text-muted-foreground">Rejection reason</span>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} className="input-base w-full" maxLength={300} placeholder="Reason shown to the applicant" />
                </label>
                <button type="button" onClick={reject} disabled={pending} className="btn-secondary min-h-[44px] px-4 text-xs">
                  Reject
                </button>
              </div>
            </>
          )}
          {error && options ? (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function EntityRegistrationsView({ requests }: { requests: EntityRegistrationRequestRow[] }) {
  const [rows, setRows] = useState(requests);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        No pending registration requests for your entity.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <RequestCard key={r.id} row={r} onDone={(id) => setRows((prev) => prev.filter((x) => x.id !== id))} />
      ))}
    </div>
  );
}
