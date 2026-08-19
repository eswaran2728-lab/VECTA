"use client";

import { useState } from "react";
import {
  STATIONS,
  REQUESTABLE_ROLES,
  ROLE_LABELS,
  ORG_WIDE_ROLES,
  OPS_GROUPS,
  OPS_GROUP_LABELS,
  OPS_GROUP_REQUIRED_ROLES,
  type UserRole,
} from "@/lib/avsec/reference-data";
import { createStaffAccount } from "@/lib/avsec/admin/actions";

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function CreateAccountForm() {
  const [role, setRole] = useState<UserRole | "">("");
  const [password, setPassword] = useState("");
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const needsOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(role);

  return (
    <section className="card p-5">
      <h2 className="section-title mb-4">Create account</h2>
      <form action={createStaffAccount} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="field-label" htmlFor="name">
              Full Name
            </label>
            <input id="name" name="name" required className="input-base" />
          </div>
          <div>
            <label className="field-label" htmlFor="staffNo">
              Staff ID
            </label>
            <input id="staffNo" name="staffNo" className="input-base" placeholder={isOrgWide ? "Not required" : ""} />
          </div>
          <div>
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input id="email" name="email" type="email" required className="input-base" placeholder="staff@airasia.com" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="field-label" htmlFor="role">
              Role
            </label>
            <select
              id="role"
              name="role"
              required
              className="input-base"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              <option value="" disabled>
                Select role…
              </option>
              {REQUESTABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
              <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="station">
              Station
            </label>
            <select id="station" name="station" required className="input-base" defaultValue="">
              <option value="" disabled>
                Select station…
              </option>
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="team">
              Team
            </label>
            <input
              id="team"
              name="team"
              disabled={isOrgWide}
              className="input-base"
              placeholder={isOrgWide ? "Not required" : "e.g. Alpha"}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="field-label" htmlFor="opsGroup">
              Ops Group
            </label>
            <select
              id="opsGroup"
              name="opsGroup"
              required={needsOpsGroup}
              disabled={!needsOpsGroup}
              className="input-base"
              defaultValue=""
            >
              <option value="" disabled>
                {needsOpsGroup ? "Select ops group…" : "Not required"}
              </option>
              {OPS_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {OPS_GROUP_LABELS[g]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div className="sm:col-span-2">
            <label className="field-label" htmlFor="password">
              Temporary Password
            </label>
            <div className="flex gap-2">
              <input
                id="password"
                name="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-base"
                placeholder="At least 6 characters"
              />
              <button type="button" className="btn-secondary shrink-0" onClick={() => setPassword(generatePassword())}>
                Generate
              </button>
            </div>
          </div>
          <button type="submit" className="btn-primary w-full">
            Create account
          </button>
        </div>
      </form>
    </section>
  );
}
