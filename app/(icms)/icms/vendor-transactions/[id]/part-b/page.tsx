import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { loadVendorDelivery } from "@/lib/caterlink/vendor";
import { VendorPartBForm } from "./vendor-part-b-form";

export const metadata: Metadata = { title: "Vendor Part B — Security check" };
export const dynamic = "force-dynamic";

export default async function VendorPartBPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireProfile();

  const supabase = await createClient();
  const { delivery } = await loadVendorDelivery(supabase, id);
  // Row-level security only exposes a delivery to a scan-authorised officer at its station (or to its
  // owner / Management); anyone else gets a 404 here and the RPC would refuse them anyway.
  if (!delivery) notFound();
  if (profile.role === "vendor" || delivery.status !== "CREATED") redirect(`/icms/vendor-transactions/${id}`);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Part B — Security check</h1>
        <span className="font-mono text-sm text-muted-foreground">{delivery.delivery_number}</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Part A on file (Vendor)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">Driver:</span> {delivery.driver_name}
          </p>
          <p>
            <span className="text-muted-foreground">NRIC:</span> <span className="font-mono">{delivery.driver_nric}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            The seal number and vehicle are not shown here — check the physical seal and vehicle and enter what you observe below.
          </p>
        </CardContent>
      </Card>

      <VendorPartBForm transactionId={id} officerName={profile.name} officerStaffId={profile.staff_id} />
    </div>
  );
}
