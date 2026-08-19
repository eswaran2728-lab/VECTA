import type { Metadata } from "next";
import { requireRole } from "@/lib/icms/auth";
import { VendorPartAForm } from "./vendor-part-a-form";

export const metadata: Metadata = { title: "New Vendor Delivery (Part A)" };
export const dynamic = "force-dynamic";

export default async function NewVendorTransactionPage() {
  await requireRole(["vendor"]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight">New Vendor Delivery</h1>
        <p className="text-sm text-muted-foreground">
          Part A — enter your details and sign. A transaction number and QR pass are generated on
          submit; show the QR code to AirAsia Security (Post 2) next.
        </p>
      </div>
      <VendorPartAForm />
    </div>
  );
}
