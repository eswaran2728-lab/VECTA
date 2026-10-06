import type { Metadata } from "next";
import { isModuleMissing } from "@/lib/icms/module-state";
import { ModuleNotActivated } from "@/components/icms/ModuleNotActivated";
import Link from "next/link";
import { requireProfile } from "@/lib/icms/auth";
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
import { Badge } from "@/components/icms/ui/badge";
import {
  INCIDENT_STATUS_COLORS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
} from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import { IncidentResolve } from "./incident-resolve";
import type { Incident, Transaction } from "@/lib/icms/database.types";
import { HighlightRow } from "@/components/dashboard/HighlightRow";

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

type IncidentRow = Incident & { severity?: string; transactions: Pick<Transaction, "transaction_number" | "vehicle_number"> | null };

export default async function IncidentsPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ highlight?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const canResolve = profile.role === "supervisor" || profile.role === "enforcement" || profile.role === "management";
  const supabase = await createClient();

  // Canonical Phase 9 incidents (row-level security: CaterLink Management / Operation Manager / Main
  // Enforcement in the AOC, or the reporter / assignee).
  const { data, error: incidentsError } = await supabase
    .from("caterlink_incidents" as never)
    .select("*, transactions!inner(transaction_number, vehicle_number, archived)")
    .eq("transactions.archived", false)
    .order("created_at", { ascending: false })
    .limit(200);

  if (isModuleMissing(incidentsError)) {
    return <ModuleNotActivated title="Incidents" detail="The incident module is not available on this environment, so there is no incident data to show." />;
  }

  const incidents = (data ?? []) as unknown as IncidentRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Incidents</h1>
        <p className="text-sm text-muted-foreground">
          Escalated security events across all checkpoints.
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>When</TableHead>
              {canResolve ? <TableHead>Resolution</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No incidents reported.
                </TableCell>
              </TableRow>
            ) : (
              incidents.map((incident) => (
                <HighlightRow key={incident.id} id={incident.id} highlightId={searchParams.highlight}>
                  <TableCell>
                    <Link
                      href={`/icms/transactions/${incident.transaction_id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {incident.transactions?.transaction_number ?? "—"}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {incident.transactions?.vehicle_number}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">
                      {INCIDENT_TYPE_LABELS[incident.incident_type]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={INCIDENT_STATUS_COLORS[incident.status]}>
                      {INCIDENT_STATUS_LABELS[incident.status]}
                    </Badge>
                    {incident.resolution_notes ? (
                      <span className="mt-1 block max-w-48 text-xs text-muted-foreground">
                        “{incident.resolution_notes}”
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-md text-sm">{incident.description}</TableCell>
                  <TableCell className="text-sm capitalize">{incident.severity ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(incident.created_at)}
                  </TableCell>
                  {canResolve ? (
                    <TableCell className="min-w-56">
                      <IncidentResolve
                        incidentId={incident.id}
                        incidentType={incident.incident_type}
                        currentStatus={incident.status}
                      />
                    </TableCell>
                  ) : null}
                </HighlightRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
