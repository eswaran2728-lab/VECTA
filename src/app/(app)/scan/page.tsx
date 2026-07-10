import type { Metadata } from "next";
import { requireProfile } from "@/lib/auth";
import { QrScanner } from "@/components/qr-scanner";

export const metadata: Metadata = { title: "Scan QR" };
export const dynamic = "force-dynamic";

export default async function ScanPage() {
  await requireProfile();

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">Scan Transaction QR</h1>
        <p className="text-sm text-muted-foreground">
          Point the camera at the vehicle&apos;s CSCS pass. You will be taken straight to the
          checkpoint form.
        </p>
      </div>
      <QrScanner />
    </div>
  );
}
