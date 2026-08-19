import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { VendorPartCForm } from "./vendor-part-c-form";
import type { VendorPartA, VendorPartB, VendorTransaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Vendor Part C — Warehouse" };
export const dynamic = "force-dynamic";

export default async function VendorPartCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["warehouse_pic"]);

  const supabase = await createClient();
  const { data: txRow } = await supabase.from("vendor_transactions").select("*").eq("id", id).single();
  if (!txRow) notFound();
  const transaction = txRow as VendorTransaction;

  if (transaction.status !== "SECURITY_VERIFIED" && transaction.status !== "PART_C_PARTIAL") {
    redirect(`/icms/vendor-transactions/${id}`);
  }

  const [partARes, partBRes] = await Promise.all([
    supabase.from("vendor_part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("vendor_part_b").select("*").eq("transaction_id", id).maybeSingle(),
  ]);
  const partA = partARes.data as VendorPartA | null;
  const partB = partBRes.data as VendorPartB | null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Part C — Warehouse (In-Flight)</h1>
        <span className="font-mono text-sm text-muted-foreground">
          {transaction.transaction_number}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review — check all details before signing</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-muted-foreground">Part A — Vendor</p>
            <p>Driver: {partA?.driver_name ?? "—"}</p>
            <p className="font-mono">NRIC: {partA?.nric_number ?? "—"}</p>
            <p className="font-mono">Seal: {partA?.seal_number ?? "—"}</p>
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-medium text-muted-foreground">Part B — AirAsia Security</p>
            <p className="font-mono">Vehicle: {partB?.vehicle_registration_no ?? "—"}</p>
            <p>
              Driver: {partB?.driver_name ?? "—"} ({partB?.driver_nric ?? "—"})
            </p>
            <p className="font-mono">Seal: {partB?.seal_number ?? "—"}</p>
            <p>
              ASO: {partB?.avsec_name ?? "—"} ({partB?.avsec_staff_id ?? "—"})
            </p>
            {partB?.remarks ? <p className="text-muted-foreground">“{partB.remarks}”</p> : null}
          </div>
        </CardContent>
      </Card>

      <p className="rounded-md bg-amber-100 p-3 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
        I hereby declare that the information given above is true and accurate to the best of my
        knowledge. Both the Warehouse PIC and the Vendor Driver must sign below on this device
        before submitting.
      </p>

      <VendorPartCForm
        transactionId={id}
        warehousePicName={profile.name}
        vendorDriverName={partA?.driver_name ?? "Vendor Driver"}
      />
    </div>
  );
}
