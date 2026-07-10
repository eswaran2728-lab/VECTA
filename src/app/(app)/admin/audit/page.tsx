import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import type { AuditLog } from "@/lib/database.types";

export const metadata: Metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requireRole(["supervisor"]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("audit_logs")
    .select("*")
    .order("performed_at", { ascending: false })
    .limit(300);

  const logs = (data ?? []) as AuditLog[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">
          Immutable record of every write across the workflow (latest 300 events).
        </p>
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
                        href={`/transactions/${log.transaction_id}`}
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
