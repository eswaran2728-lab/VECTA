import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { IncidentForm } from "./incident-form";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Report Incident" };
export const dynamic = "force-dynamic";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProfile();

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-red-700 dark:text-red-400">
          Report Incident
        </h1>
        <p className="font-mono text-sm text-muted-foreground">
          {transaction.transaction_number} · {transaction.vehicle_number} · Seal{" "}
          {transaction.seal_number}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Submitting escalates the transaction immediately and notifies the supervisor.
        </p>
      </div>
      <IncidentForm transactionId={transaction.id} />
    </div>
  );
}
