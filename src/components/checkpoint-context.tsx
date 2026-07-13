import { CheckCircle2, LockKeyhole } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import type { PartA, PartBC, PartD, Transaction } from "@/lib/database.types";

function CompletedPart({
  label,
  person,
  completedAt,
  remarks,
}: {
  label: string;
  person: string;
  completedAt: string;
  remarks: string | null;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        {label} completed
      </div>
      <p className="mt-1 text-sm">{person}</p>
      <p className="text-xs text-muted-foreground">{formatDateTime(completedAt)}</p>
      {remarks ? <p className="mt-2 text-sm text-muted-foreground">Remarks: {remarks}</p> : null}
    </div>
  );
}

export function CheckpointContext({
  transaction,
  partA,
  partB,
  partC,
  partD,
}: {
  transaction: Transaction;
  partA: PartA | null;
  partB?: PartBC | null;
  partC?: PartBC | null;
  partD?: PartD | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyhole className="h-4 w-4 text-muted-foreground" />
          Existing transaction data — read only
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Vehicle / Registration</dt>
            <dd className="font-mono font-semibold">{transaction.vehicle_number}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Driver</dt>
            <dd className="font-semibold">{transaction.driver_name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Driver IC / ID</dt>
            <dd className="font-mono font-semibold">{transaction.driver_id}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Flight</dt>
            <dd className="font-mono font-semibold">{transaction.flight_number || "—"}</dd>
          </div>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          {partA ? (
            <CompletedPart
              label="Part A"
              person={`${partA.pic_name} (${partA.pic_staff_id})`}
              completedAt={partA.completed_at}
              remarks={partA.remarks}
            />
          ) : null}
          {partB ? (
            <CompletedPart
              label="Part B"
              person={`${partB.avsec_name} (${partB.avsec_staff_id})`}
              completedAt={partB.completed_at}
              remarks={partB.remarks}
            />
          ) : null}
          {partC ? (
            <CompletedPart
              label="Part C"
              person={`${partC.avsec_name} (${partC.avsec_staff_id})`}
              completedAt={partC.completed_at}
              remarks={partC.remarks}
            />
          ) : null}
          {partD ? (
            <CompletedPart
              label="Part D"
              person={`${partD.receiver_name} (${partD.receiver_staff_id})`}
              completedAt={partD.completed_at}
              remarks={partD.remarks}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
