import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CheckpointForm } from "@/components/checkpoint-form";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part C — AVSEC Post 6" };
export const dynamic = "force-dynamic";

export default async function PartCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["post6_avsec"]);

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  if (transaction.status !== "POST2_APPROVED") {
    redirect(`/transactions/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Part C — AVSEC Post 6</h1>
        <p className="font-mono text-sm text-muted-foreground">
          {transaction.transaction_number}
        </p>
      </div>
      <CheckpointForm
        part="part_c"
        transaction={transaction}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
      />
    </div>
  );
}
