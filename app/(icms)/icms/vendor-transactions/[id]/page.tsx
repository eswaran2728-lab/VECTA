import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/icms/storage";
import { generateQrToken } from "@/lib/icms/qr-token";
import { QrDisplay } from "@/components/icms/qr-display";
import { Badge } from "@/components/icms/ui/badge";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { formatDateTime } from "@/lib/icms/utils";
import {
  VENDOR_DELIVERY_STATUS_COLORS,
  VENDOR_DELIVERY_STATUS_LABELS,
  loadVendorDelivery,
  type VendorCheckpoint,
} from "@/lib/caterlink/vendor";

export const metadata: Metadata = { title: "Vendor Delivery" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const STAGE_TITLES: Record<VendorCheckpoint["stage"], string> = {
  A: "Part A — Vendor",
  B: "Part B — Security check",
  C: "Part C — Vendor confirmation",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export default async function VendorTransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireProfile();
  // CaterLink Driver and Vendor are separate parties: this workflow belongs to the other one (and to Management/officers).
  if (profile.identity === "external" && profile.role === "warehouse_pic") redirect("/icms/dashboard?error=forbidden");

  const supabase = await createClient();
  const { delivery, checkpoints } = await loadVendorDelivery(supabase, id);
  if (!delivery) notFound();

  const sigs = await Promise.all(checkpoints.map((c) => signedUrl("signatures", c.signature_url)));
  const isOwner = profile.role === "vendor" && delivery.vendor_user_id === profile.id;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-bold tracking-tight">{delivery.delivery_number}</h1>
          <Badge className={VENDOR_DELIVERY_STATUS_COLORS[delivery.status]}>{VENDOR_DELIVERY_STATUS_LABELS[delivery.status]}</Badge>
        </div>
        {isOwner && delivery.status === "SECURITY_VERIFIED" ? (
          <Link href={`/icms/vendor-transactions/${delivery.id}/part-c`}>
            <Button size="lg">Confirm handover</Button>
          </Link>
        ) : null}
      </div>

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR Pass</CardTitle>
          </CardHeader>
          <CardContent>
            <QrDisplay token={generateQrToken(delivery.id, "VENDOR")} transactionNumber={delivery.delivery_number} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Overview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <Row label="Driver" value={`${delivery.driver_name} (${delivery.driver_nric})`} />
          <Row label="Vehicle" value={delivery.vehicle_registration_no} />
          <Row label="Seal Number" value={delivery.seal_number} />
          {delivery.supplies_description ? <Row label="Supplies" value={delivery.supplies_description} /> : null}
          <Row label="Created" value={formatDateTime(delivery.created_at)} />
          <Row label="Completed" value={formatDateTime(delivery.completed_at)} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {checkpoints.map((c, i) => (
          <Card key={c.id}>
            <CardHeader>
              <CardTitle className="text-base">{STAGE_TITLES[c.stage]}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Row label="By" value={`${c.actor_name} (${c.actor_staff_id})`} />
              <Row label="Result" value={c.result} />
              <Row label="Completed" value={formatDateTime(c.completed_at)} />
              {c.observed ? (
                <div className="rounded-md bg-muted p-2 text-xs">
                  <p className="mb-1 font-medium">Observed at the check</p>
                  {Object.entries(c.observed).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-muted-foreground">{k.replace(/_/g, " ")}:</span> {v}
                    </p>
                  ))}
                </div>
              ) : null}
              {c.remarks ? <p className="text-sm text-muted-foreground">“{c.remarks}”</p> : null}
              {c.escalation_reason ? <p className="text-sm font-medium text-orange-700">Escalated: {c.escalation_reason}</p> : null}
              {sigs[i] ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Signature</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sigs[i] as string} alt="Signature" className="h-20 rounded border bg-white object-contain" />
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
