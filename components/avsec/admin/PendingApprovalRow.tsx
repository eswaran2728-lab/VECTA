"use client";

import { useState } from "react";
import { approveUserWithAssignment, rejectUser } from "@/lib/avsec/admin/actions";
import { validateApprovalAssignment } from "@/lib/avsec/admin/validation";
import { STATIONS, REQUESTABLE_ROLES, ROLE_LABELS, OPS_GROUPS, OPS_GROUP_LABELS, ORG_WIDE_ROLES, OPS_GROUP_REQUIRED_ROLES } from "@/lib/avsec/reference-data";
import type { Profile } from "@/lib/avsec/types";

/**
 * Management must explicitly review and select the FINAL role/station/
 * team/ops_group before a pending registration can be approved — the
 * requested values the registrant typed into their own profile-setup
 * form are shown as a starting point only, never auto-submitted as
 * final. The Approve button stays disabled until the current selection
 * passes the same validation the server enforces authoritatively
 * (validateApprovalAssignment) — this is a UX convenience only; the
 * server re-validates everything from scratch and is what actually
 * decides whether the write is accepted.
 */
export function PendingApprovalRow({ profile: p }: { profile: Profile }) {
  const [role, setRole] = useState<string>(p.role);
  const [station, setStation] = useState(p.station ?? "");
  const [team, setTeam] = useState(p.team ?? "");
  const [opsGroup, setOpsGroup] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const needsOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(role);
  const validation = validateApprovalAssignment({ role, station, team, opsGroup });

  return (
    <div className="py-3 space-y-3">
      <div className="min-w-0">
        <p className="font-semibold text-sm text-foreground truncate">{p.name || p.email}</p>
        <p className="font-mono text-xs text-muted-foreground truncate">
          {p.email} · {p.staff_no}
        </p>
        <p className="font-mono text-xs text-primary font-semibold mt-1">
          Requested: {ROLE_LABELS[p.role]} · {p.station || "—"} · {p.team || "—"}
        </p>
      </div>

      {!rejecting ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <label className="field-label">Final role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="input-base text-xs">
                {REQUESTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Station</label>
              <select value={station} onChange={(e) => setStation(e.target.value)} className="input-base text-xs">
                <option value="" disabled>
                  Select…
                </option>
                {STATIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Team{isOrgWide ? " (n/a)" : ""}</label>
              <input
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                disabled={isOrgWide}
                placeholder="e.g. ALPHA"
                className="input-base text-xs"
              />
            </div>
            <div>
              <label className="field-label">Ops group{needsOpsGroup ? "" : " (n/a)"}</label>
              <select
                value={opsGroup}
                onChange={(e) => setOpsGroup(e.target.value)}
                disabled={!needsOpsGroup}
                className="input-base text-xs"
              >
                <option value="" disabled>
                  Select…
                </option>
                {OPS_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {OPS_GROUP_LABELS[g]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!validation.ok && <p className="field-error text-xs">{validation.error}</p>}

          <div className="flex gap-2">
            <form action={approveUserWithAssignment}>
              <input type="hidden" name="profileId" value={p.id} />
              <input type="hidden" name="role" value={role} />
              <input type="hidden" name="station" value={station} />
              <input type="hidden" name="team" value={team} />
              <input type="hidden" name="opsGroup" value={opsGroup} />
              <button type="submit" disabled={!validation.ok} className="btn-primary py-2 px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed">
                Approve
              </button>
            </form>
            <button type="button" onClick={() => setRejecting(true)} className="btn-secondary py-2 px-3 text-xs">
              Reject
            </button>
          </div>
        </>
      ) : (
        <form action={rejectUser} className="space-y-2">
          <input type="hidden" name="profileId" value={p.id} />
          <label className="field-label">Rejection reason</label>
          <textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input-base text-xs w-full"
            rows={2}
            placeholder="Optional — shown internally, not to the applicant."
          />
          <div className="flex gap-2">
            <button type="submit" className="btn-primary py-2 px-3 text-xs">
              Confirm rejection
            </button>
            <button type="button" onClick={() => setRejecting(false)} className="btn-secondary py-2 px-3 text-xs">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
