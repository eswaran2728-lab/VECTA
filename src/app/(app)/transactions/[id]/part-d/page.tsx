import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PartDForm } from "@/components/part-d-form";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part D — Delivery" };
export const dynamic = "force-dynamic";

export default async function PartDPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["receiver"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  if (transaction.status !== "POST6_APPROVED") {
    redirect(`/transactions/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Part D — Delivery Confirmation</h1>
        <p className="font-mono text-sm text-muted-foreground">
          {transaction.transaction_number}
        </p>
      </div>
      <PartDForm
        transaction={transaction}
        receiverName={profile.name}
        receiverStaffId={profile.staff_id}
      />
    </div>
  );
}
