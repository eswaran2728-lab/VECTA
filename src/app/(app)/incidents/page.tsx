import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
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
import { Badge } from "@/components/ui/badge";
import {
  INCIDENT_STATUS_COLORS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import { signedUrl } from "@/lib/storage";
import { IncidentResolve } from "./incident-resolve";
import { IncidentPdfButton } from "./incident-pdf-button";
import type { Incident, IncidentPhoto, Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

type IncidentRow = Incident & { transactions: Pick<Transaction, "transaction_number" | "vehicle_number"> | null };

export default async function IncidentsPage() {
  const profile = await requireProfile();
  const canResolve = profile.role === "supervisor" || profile.role === "enforcement";
  const supabase = await createClient();

  const { data } = await supabase
    .from("incidents")
    .select("*, transactions!inner(transaction_number, vehicle_number, archived)")
    .eq("transactions.archived", false)
    .order("created_at", { ascending: false })
    .limit(200);

  const incidents = (data ?? []) as unknown as IncidentRow[];

  // Signed photo URLs for the per-incident PDF export.
  const { data: photoRows } = await supabase
    .from("incident_photos")
    .select("*")
    .in("incident_id", incidents.map((i) => i.id));
  const photoUrlMap = new Map<string, string[]>();
  for (const photo of (photoRows ?? []) as IncidentPhoto[]) {
    const url = await signedUrl("incident-photos", photo.photo_url);
    if (url) {
      photoUrlMap.set(photo.incident_id, [...(photoUrlMap.get(photo.incident_id) ?? []), url]);
    }
  }

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
              <TableHead>Reported by</TableHead>
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
                <TableRow key={incident.id}>
                  <TableCell>
                    <Link
                      href={`/transactions/${incident.transaction_id}`}
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
                  <TableCell className="text-sm">{incident.reported_by}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(incident.created_at)}
                    <span className="block">
                      <IncidentPdfButton
                        incident={incident}
                        transactionNumber={incident.transactions?.transaction_number ?? "—"}
                        vehicleNumber={incident.transactions?.vehicle_number ?? "—"}
                        photoUrls={photoUrlMap.get(incident.id) ?? []}
                      />
                    </span>
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
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
