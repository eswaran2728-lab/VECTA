import type { Metadata } from "next";
import Link from "next/link";
import { isModuleMissing } from "@/lib/icms/module-state";
import { ModuleNotActivated } from "@/components/icms/ModuleNotActivated";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { callCaterlinkRpc } from "@/lib/caterlink/vendor";
import { Card } from "@/components/icms/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/icms/ui/table";
import { formatDateTime } from "@/lib/icms/utils";

export const metadata: Metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

/** Where an audited entity can be opened, when it has a page. */
function entityHref(row: AuditRow): string | null {
  if (!row.entity_id) return null;
  if (row.entity_type === "transaction") return `/icms/transactions/${row.entity_id}`;
  if (row.entity_type === "caterlink_vendor_delivery") return `/icms/vendor-transactions/${row.entity_id}`;
  return null;
}

export default async function AuditPage() {
  await requireRole(["supervisor"]);
  const supabase = await createClient();

  // The canonical audit log (phase8_audit_log) has no client read grant; CaterLink Management reads the
  // events for its own AOC through this authorised RPC, which refuses everyone else.
  const { data, error } = await callCaterlinkRpc(supabase, "list_caterlink_audit_secure", { p_limit: 300 });
  if (isModuleMissing(error)) {
    return <ModuleNotActivated title="Audit log" detail="The CaterLink audit log is not activated on this environment, so there is no data available." />;
  }
  const logs = (data ?? []) as AuditRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">
          Immutable record of CaterLink actions in your AOC (latest 300 events).
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-red-100 p-3 text-sm font-medium text-red-800">
          The audit log could not be loaded: {error.message.replace(/^ERROR:\s*/i, "")}
        </p>
      ) : null}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Performed by</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Detail</TableHead>
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
              logs.map((log) => {
                const href = entityHref(log);
                return (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(log.created_at)}</TableCell>
                    <TableCell className="font-mono text-xs">{log.action}</TableCell>
                    <TableCell className="text-sm">{log.actor_name ?? "—"}</TableCell>
                    <TableCell>
                      {href && log.entity_id ? (
                        <Link href={href} className="font-mono text-xs text-primary hover:underline">
                          {log.entity_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">{log.entity_type}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">detail</summary>
                        <pre className="mt-1 max-h-40 max-w-md overflow-auto rounded bg-muted p-2">{JSON.stringify(log.detail, null, 2)}</pre>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
