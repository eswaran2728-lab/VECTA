"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import { ALL_ROLES, ROLE_LABELS } from "@/lib/constants";
import type { Role } from "@/lib/database.types";

/** Filters the audit log by the acting user's role (joined via public.users). */
export function AuditRoleFilter({ role }: { role: Role | "" }) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <Select
        value={role}
        onChange={(e) => router.push(e.target.value ? `/admin/audit?role=${e.target.value}` : "/admin/audit")}
        className="h-9 w-auto text-sm"
      >
        <option value="">All roles</option>
        {ALL_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </Select>
    </div>
  );
}
