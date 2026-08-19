import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/icms/auth";
import { getLang } from "@/lib/icms/actions/language";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/icms/workflow";
import { PartDForm } from "@/components/icms/part-d-form";
import { DirectionBadge } from "@/components/icms/direction-badge";
import { WorkflowStepper } from "@/components/icms/workflow-stepper";
import { CheckpointContext } from "@/components/icms/checkpoint-context";
import { Card, CardContent } from "@/components/icms/ui/card";
import type { PartA, PartBC, Seal, Transaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Part D — Delivery" };
export const dynamic = "force-dynamic";

export default async function PartDPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["receiver"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  // Part D is OUTBOUND-only; getStep returns null for INBOUND.
  const step = getStep(transaction.direction, "part_d");
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/icms/transactions/${id}`);
  }

  const [sealRes, partARes, partBRes, partCRes] = await Promise.all([
    supabase
      .from("seals")
      .select("id, seal_number, seal_type, seal_color")
      .eq("transaction_id", id)
      .order("applied_at"),
    supabase.from("part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_b").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_c").select("*").eq("transaction_id", id).maybeSingle(),
  ]);
  const seals = (sealRes.data ?? []) as Pick<
    Seal,
    "id" | "seal_number" | "seal_type" | "seal_color"
  >[];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Part D — Delivery Confirmation</h1>
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

      <CheckpointContext
        transaction={transaction}
        partA={partARes.data as PartA | null}
        partB={partBRes.data as PartBC | null}
        partC={partCRes.data as PartBC | null}
      />

      <PartDForm
        transaction={transaction}
        seals={seals}
        receiverName={profile.name}
        receiverStaffId={profile.staff_id}
        lang={await getLang()}
      />
    </div>
  );
}
