import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCheckpointRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { checkpointOrderError, getStep } from "@/lib/icms/workflow";
import { CheckpointForm } from "@/components/icms/checkpoint-form";
import type { Seal, Transaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Part B checkpoint" };
export const dynamic = "force-dynamic";

/**
 * Part B -- In-flight Security Post (Post 2). Authority is canonical (requireCheckpointRole: approved profile, active station-operator
 * assignment, scan capability, not Staff Profiling, on duty) and is re-checked inside record_caterlink_part_b_secure(); the page only
 * shows the form for a movement the caller can see (RLS) that is waiting for this step.
 */
export default async function PartBPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCheckpointRole("post2_avsec");
  const supabase = await createClient();

  const { data: txRow } = await supabase.from("transactions").select("*").eq("id", id).maybeSingle();
  if (!txRow) notFound();
  const transaction = txRow as unknown as Transaction;

  const orderError = checkpointOrderError(transaction.direction, "part_b", transaction.status, transaction.route);
  if (orderError) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-4">
        <h1 className="text-2xl font-bold tracking-tight">Part B — In-flight Security Post</h1>
        <p role="status" className="rounded-md border p-4 text-sm">
          {orderError}
        </p>
        <Link href={`/icms/transactions/${transaction.id}`} className="inline-flex min-h-[44px] items-center text-sm font-medium text-primary underline">
          Back to {transaction.transaction_number}
        </Link>
      </div>
    );
  }

  const { data: sealRows } = await supabase
    .from("seals")
    .select("id, seal_number, seal_type, seal_color, superseded_at")
    .eq("transaction_id", transaction.id)
    .is("superseded_at", null)
    .order("applied_at", { ascending: true });
  const seals = (sealRows ?? []) as unknown as Pick<Seal, "id" | "seal_number" | "seal_type" | "seal_color">[];
  const finalizes = getStep(transaction.direction, "part_b", transaction.route)?.finalizes ?? false;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Part B — In-flight Security Post</h1>
        <p className="text-sm text-muted-foreground">
          {transaction.transaction_number} · {transaction.direction === "INBOUND" ? "Inbound (final checkpoint)" : "Outbound"}
        </p>
      </div>
      {seals.length === 0 ? (
        <p role="alert" className="rounded-md border border-destructive p-4 text-sm">
          No seals are on record for this transaction, so Part B cannot be completed. Contact CaterLink Management.
        </p>
      ) : (
        <CheckpointForm part="part_b" transaction={transaction} seals={seals} officerName={profile.name} officerStaffId={profile.staff_id ?? ""} finalizes={finalizes} />
      )}
    </div>
  );
}
