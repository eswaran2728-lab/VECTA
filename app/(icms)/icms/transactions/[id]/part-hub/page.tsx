import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireCheckpointRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/icms/workflow";
import { DirectionBadge } from "@/components/icms/direction-badge";
import { WorkflowStepper } from "@/components/icms/workflow-stepper";
import { Card, CardContent } from "@/components/icms/ui/card";
import { HUB_DESTINATION_LABELS } from "@/lib/icms/constants";
import { PartHubForm } from "./part-hub-form";
import type { PartA, Transaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Part Hub — Delivery Confirmation" };
export const dynamic = "force-dynamic";

export default async function PartHubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCheckpointRole("hub_avsec");

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const step = getStep(transaction.direction, "part_hub", transaction.route);
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/icms/transactions/${id}`);
  }
  if (!transaction.hub_destination) {
    redirect(`/icms/transactions/${id}`);
  }

  const { data: partARow } = await supabase
    .from("part_a")
    .select("*")
    .eq("transaction_id", id)
    .maybeSingle();
  const partA = partARow as PartA | null;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{step.label}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <DirectionBadge direction={transaction.direction} />
          <span className="font-mono text-sm text-muted-foreground">
            {transaction.transaction_number}
          </span>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <WorkflowStepper
            direction={transaction.direction}
            status={transaction.status}
            route={transaction.route}
            parts={partsDoneFromStatus(transaction.direction, transaction.status, transaction.route)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6 text-sm">
          <p>
            <span className="text-muted-foreground">Vehicle:</span>{" "}
            <span className="font-mono">{transaction.vehicle_number}</span>
          </p>
          <p>
            <span className="text-muted-foreground">Driver:</span> {transaction.driver_name} (
            <span className="font-mono">{transaction.driver_id}</span>)
          </p>
          <p>
            <span className="text-muted-foreground">Destination:</span>{" "}
            <span className="font-semibold">{HUB_DESTINATION_LABELS[transaction.hub_destination]}</span>
          </p>
          {partA ? (
            <p>
              <span className="text-muted-foreground">Part A PIC:</span> {partA.pic_name} (
              {partA.pic_staff_id})
            </p>
          ) : null}
        </CardContent>
      </Card>

      <PartHubForm
        transactionId={id}
        destinationLabel={HUB_DESTINATION_LABELS[transaction.hub_destination]}
        hubAvsecName={profile.name}
        hubAvsecStaffId={profile.staff_id}
      />
    </div>
  );
}
