import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { loadVendorDelivery } from "@/lib/caterlink/vendor";
import { VendorPartCForm } from "./vendor-part-c-form";

export const metadata: Metadata = { title: "Vendor Part C — Confirm handover" };
export const dynamic = "force-dynamic";

export default async function VendorPartCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["vendor"]);

  const supabase = await createClient();
  const { delivery, checkpoints } = await loadVendorDelivery(supabase, id);
  if (!delivery || delivery.vendor_user_id !== profile.id) notFound();
  if (delivery.status !== "SECURITY_VERIFIED") redirect(`/icms/vendor-transactions/${id}`);
  const partB = checkpoints.find((c) => c.stage === "B");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Part C — Confirm handover</h1>
        <span className="font-mono text-sm text-muted-foreground">{delivery.delivery_number}</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review — check all details before signing</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-muted-foreground">Part A — Vendor</p>
            <p>Driver: {delivery.driver_name}</p>
            <p className="font-mono">Vehicle: {delivery.vehicle_registration_no}</p>
            <p className="font-mono">Seal: {delivery.seal_number}</p>
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-medium text-muted-foreground">Part B — Security check</p>
            <p>
              Officer: {partB?.actor_name ?? "—"} ({partB?.actor_staff_id ?? "—"})
            </p>
            {partB?.remarks ? <p className="text-muted-foreground">“{partB.remarks}”</p> : null}
          </div>
        </CardContent>
      </Card>

      <p className="rounded-md bg-amber-100 p-3 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
        I confirm the information above is true and accurate and that the delivery has been handed over.
      </p>

      <VendorPartCForm transactionId={id} vendorDriverName={delivery.driver_name} />
    </div>
  );
}
