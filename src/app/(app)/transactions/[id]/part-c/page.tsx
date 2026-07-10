import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/workflow";
import { CheckpointForm } from "@/components/checkpoint-form";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { Card, CardContent } from "@/components/ui/card";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part C — Airport Security Post" };
export const dynamic = "force-dynamic";

export default async function PartCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["post6_avsec"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const step = getStep(transaction.direction, "part_c");
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/transactions/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
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
            parts={partsDoneFromStatus(transaction.direction, transaction.status)}
          />
        </CardContent>
      </Card>

      <CheckpointForm
        part="part_c"
        transaction={transaction}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
        finalizes={step.finalizes}
      />
    </div>
  );
}
