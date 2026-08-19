"use client";

import { useMemo, useState } from "react";
import { ROLE_LABELS, STATIONS, USER_ROLES } from "@/lib/avsec/reference-data";
import { updateUserAssignment, approveUser, deactivateUser, deleteUserAccount } from "@/lib/avsec/admin/actions";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import type { Profile } from "@/lib/avsec/types";
import { cn } from "@/lib/avsec/utils";

export function UsersTable({ users }: { users: Profile[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (p) => p.name.toLowerCase().includes(q) || p.staff_no.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="section-title">All users</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">{filtered.length} of {users.length}</span>
      </div>

      <div className="relative mb-4">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
        </svg>
        <input
          className="input-base pl-9"
          placeholder="Search by staff name, staff ID or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 && (
        <p className="py-4 text-sm text-center text-slate-500 dark:text-slate-400">No users match &ldquo;{query}&rdquo;.</p>
      )}

      <div className="overflow-x-auto -mx-5">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
              <th className="px-5 py-2 font-semibold">Name</th>
              <th className="px-2 py-2 font-semibold">Staff ID</th>
              <th className="px-2 py-2 font-semibold">Email</th>
              <th className="px-2 py-2 font-semibold">Role</th>
              <th className="px-2 py-2 font-semibold">Station / Team</th>
              <th className="px-2 py-2 font-semibold">Status</th>
              <th className="px-2 py-2 font-semibold">Since</th>
              <th className="px-5 py-2 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {filtered.map((p) => (
              <UserRow key={p.id} profile={p} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Each row's forms live here, outside the table (a <form> can't be a valid child of
          <tr>/<tbody>) — row inputs/buttons link back to them via the `form` attribute. */}
      {filtered.map((p) => (
        <div key={p.id} className="hidden">
          <form id={`edit-user-${p.id}`} action={updateUserAssignment}>
            <input type="hidden" name="profileId" value={p.id} />
          </form>
          <form id={`reactivate-user-${p.id}`} action={approveUser}>
            <input type="hidden" name="profileId" value={p.id} />
          </form>
          <form id={`deactivate-user-${p.id}`} action={deactivateUser}>
            <input type="hidden" name="profileId" value={p.id} />
          </form>
          <form id={`delete-user-${p.id}`} action={deleteUserAccount}>
            <input type="hidden" name="profileId" value={p.id} />
          </form>
        </div>
      ))}
    </section>
  );
}

function UserRow({ profile: p }: { profile: Profile }) {
  const formId = `edit-user-${p.id}`;

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="px-5 py-3 font-medium whitespace-nowrap">{p.name || <span className="text-slate-400">—</span>}</td>
      <td className="px-2 py-3 whitespace-nowrap font-mono text-xs">{p.staff_no || "—"}</td>
      <td className="px-2 py-3 whitespace-nowrap text-slate-500 dark:text-slate-400">{p.email}</td>
      <td className="px-2 py-3">
        <select form={formId} name="role" defaultValue={p.role} className="input-base py-2 min-h-0 text-sm">
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-3">
        <div className="flex gap-1">
          <select form={formId} name="station" defaultValue={p.station ?? ""} className="input-base py-2 min-h-0 text-sm">
            {STATIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            form={formId}
            name="team"
            defaultValue={p.team ?? ""}
            placeholder="Team"
            className="input-base py-2 min-h-0 text-sm w-24"
          />
        </div>
      </td>
      <td className="px-2 py-3 whitespace-nowrap">
        <span
          className={cn(
            "text-xs font-bold px-2 py-1 rounded-full",
            p.status === "approved"
              ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
              : p.status === "rejected" || p.status === "deactivated"
                ? "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
          )}
        >
          {p.status.toUpperCase()}
        </span>
      </td>
      <td className="px-2 py-3 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
        {formatDateTimeMY(p.created_at, "dd MMM yyyy")}
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center justify-end gap-1 flex-wrap">
          <button form={formId} type="submit" className="btn-quiet font-semibold">
            Save
          </button>
          {p.status === "approved" ? (
            <button
              form={`deactivate-user-${p.id}`}
              type="submit"
              className="btn-quiet font-semibold text-amber-700 dark:text-amber-400"
              onClick={(e) => {
                if (!confirm(`Deactivate ${p.name || p.email}? They won't be able to sign in until reactivated.`)) {
                  e.preventDefault();
                }
              }}
            >
              Deactivate
            </button>
          ) : (
            <button form={`reactivate-user-${p.id}`} type="submit" className="btn-quiet font-semibold text-green-700 dark:text-green-400">
              Reactivate
            </button>
          )}
          <button
            form={`delete-user-${p.id}`}
            type="submit"
            className="btn-quiet font-semibold text-red-600 dark:text-red-400"
            onClick={(e) => {
              if (
                !confirm(
                  `Permanently delete ${p.name || p.email}? This cannot be undone. Only allowed if they have no report history — use Deactivate otherwise.`,
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
