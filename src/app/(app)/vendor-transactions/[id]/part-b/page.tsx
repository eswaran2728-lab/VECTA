import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VendorPartBForm } from "./vendor-part-b-form";
import type { VendorPartA, VendorTransaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Vendor Part B — AirAsia Security" };
export const dynamic = "force-dynamic";

export default async function VendorPartBPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["post2_avsec"]);

  const supabase = await createClient();
  const { data: txRow } = await supabase.from("vendor_transactions").select("*").eq("id", id).single();
  if (!txRow) notFound();
  const transaction = txRow as VendorTransaction;

  if (transaction.status !== "CREATED") {
    redirect(`/vendor-transactions/${id}`);
  }

  const { data: partARow } = await supabase
    .from("vendor_part_a")
    .select("*")
    .eq("transaction_id", id)
    .maybeSingle();
  const partA = partARow as VendorPartA | null;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Part B — AirAsia Security (Post 2)</h1>
        <span className="font-mono text-sm text-muted-foreground">
          {transaction.transaction_number}
        </span>
      </div>

      {partA ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Part A on file (Vendor)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">Driver:</span> {partA.driver_name}
            </p>
            <p>
              <span className="text-muted-foreground">NRIC:</span>{" "}
              <span className="font-mono">{partA.nric_number}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Seal Number:</span>{" "}
              <span className="font-mono">{partA.seal_number}</span>
            </p>
          </CardContent>
        </Card>
      ) : null}

      <VendorPartBForm
        transactionId={id}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
      />
    </div>
  );
}
