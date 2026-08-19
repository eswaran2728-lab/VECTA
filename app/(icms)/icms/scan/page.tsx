import type { Metadata } from "next";
import { requireRole } from "@/lib/icms/auth";
import { QrScanner } from "@/components/icms/qr-scanner";

export const metadata: Metadata = { title: "Scan QR" };
export const dynamic = "force-dynamic";

export default async function ScanPage() {
  // warehouse_pic has no catering checkpoint of their own, but they scan
  // here for Vendor Movement Part C (the warehouse dual-signature step) —
  // qr/validate's checkpointRoles gate still keeps them read-only on any
  // catering transaction's Part B/C/D. hub_avsec/redq_avsec scan for their
  // own Multi-Route checkpoints (Part Hub / Part REDQ) the same way.
  await requireRole([
    "post2_avsec",
    "post6_avsec",
    "receiver",
    "warehouse_pic",
    "hub_avsec",
    "redq_avsec",
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <QrScanner />
    </div>
  );
}
