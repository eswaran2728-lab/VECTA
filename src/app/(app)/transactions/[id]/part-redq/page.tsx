import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/workflow";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { Card, CardContent } from "@/components/ui/card";
import { PartRedqForm } from "./part-redq-form";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part REDQ — Re-seal" };
export const dynamic = "force-dynamic";

export default async function PartRedqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["redq_avsec"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const step = getStep(transaction.direction, "part_redq", transaction.route);
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/transactions/${id}`);
  }

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

      <p className="rounded-md bg-amber-100 p-3 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
        Physically read the current seal — its number and colour are not shown here. Enter what
        you observe; a mismatch escalates automatically rather than proceeding.
      </p>

      <PartRedqForm
        transactionId={id}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
      />
    </div>
  );
}
