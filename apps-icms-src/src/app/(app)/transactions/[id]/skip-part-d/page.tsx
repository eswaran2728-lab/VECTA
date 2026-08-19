import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SkipPartDForm } from "./skip-part-d-form";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Complete without Part D" };
export const dynamic = "force-dynamic";

export default async function SkipPartDPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireRole(["receiver", "supervisor"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  if (transaction.direction !== "OUTBOUND" || transaction.status !== "AIRPORT_POST_APPROVED") {
    redirect(`/transactions/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Complete without Part D</h1>
        <p className="font-mono text-sm text-muted-foreground">{transaction.transaction_number}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Part D is optional. This closes the transaction as Completed without a delivery
          confirmation on file — a reason is required and is kept on the permanent record.
        </p>
      </div>
      <SkipPartDForm transactionId={transaction.id} />
    </div>
  );
}
