import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { getLang } from "@/lib/actions/language";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/workflow";
import { CheckpointForm } from "@/components/checkpoint-form";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { Card, CardContent } from "@/components/ui/card";
import type { Seal, Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part B — In-flight Security Post" };
export const dynamic = "force-dynamic";

export default async function PartBPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["post2_avsec"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const step = getStep(transaction.direction, "part_b");
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/transactions/${id}`);
  }

  const { data: sealRows } = await supabase
    .from("seals")
    .select("id, seal_type, seal_color")
    .eq("transaction_id", id)
    .order("applied_at");
  const seals = (sealRows ?? []) as Pick<Seal, "id" | "seal_type" | "seal_color">[];

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
        {step.finalizes ? (
          <p className="rounded-md bg-green-100 p-2 text-sm font-medium text-green-800 dark:bg-green-900/40 dark:text-green-200">
            Final checkpoint — approving here completes this inbound transaction.
          </p>
        ) : null}
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
        part="part_b"
        transaction={transaction}
        seals={seals}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
        finalizes={step.finalizes}
        lang={await getLang()}
      />
    </div>
  );
}
