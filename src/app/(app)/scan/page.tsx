import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { QrScanner } from "@/components/qr-scanner";

export const metadata: Metadata = { title: "Scan QR" };
export const dynamic = "force-dynamic";

export default async function ScanPage() {
  await requireRole(["post2_avsec", "post6_avsec", "receiver"]);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <QrScanner />
    </div>
  );
}
