import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/icms/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/icms/ui/table";
import { formatDateTime } from "@/lib/icms/utils";
import { ROLE_LABELS } from "@/lib/icms/constants";
import { AuditRoleFilter } from "./audit-role-filter";
import type { AuditLog, Role } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

const ROLES = Object.keys(ROLE_LABELS) as Role[];

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  await requireRole(["supervisor"]);
  const { role: roleParam } = await searchParams;
  const role = (ROLES.includes(roleParam as Role) ? roleParam : "") as Role | "";
  const supabase = await createClient();

  let performedByIds: string[] | null = null;
  if (role) {
    const { data: usersOfRole } = await supabase.from("users").select("id").eq("role", role);
    performedByIds = (usersOfRole ?? []).map((u) => u.id);
  }

  let query = supabase
    .from("audit_logs")
    .select("*")
    .order("performed_at", { ascending: false })
    .limit(300);
  if (performedByIds) {
    // Empty array (no user has this role) still needs a filter that matches
    // nothing, rather than falling through to "all roles".
    query = query.in("performed_by_id", performedByIds.length > 0 ? performedByIds : [
      "00000000-0000-0000-0000-000000000000",
    ]);
  }
  const { data } = await query;

  const logs = (data ?? []) as AuditLog[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Immutable record of every write across the workflow (latest 300 events
            {role ? `, filtered to ${ROLE_LABELS[role]}` : ""}).
          </p>
        </div>
        <AuditRoleFilter role={role} />
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Performed by</TableHead>
              <TableHead>Transaction</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  No audit events yet.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(log.performed_at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{log.action}</TableCell>
                  <TableCell className="text-sm">{log.performed_by}</TableCell>
                  <TableCell>
                    {log.transaction_id ? (
                      <Link
                        href={`/icms/transactions/${log.transaction_id}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {log.transaction_id.slice(0, 8)}…
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        before / after
                      </summary>
                      <pre className="mt-1 max-h-40 max-w-md overflow-auto rounded bg-muted p-2">
                        {JSON.stringify(
                          { before: log.old_values, after: log.new_values },
                          null,
                          2
                        )}
                      </pre>
                    </details>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
