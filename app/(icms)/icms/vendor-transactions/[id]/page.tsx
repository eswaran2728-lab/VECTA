import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/icms/storage";
import { generateQrToken } from "@/lib/icms/qr-token";
import { QrDisplay } from "@/components/icms/qr-display";
import { Badge } from "@/components/icms/ui/badge";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { VENDOR_STATUS_COLORS, VENDOR_STATUS_LABELS } from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import type { VendorPartA, VendorPartB, VendorPartC, VendorTransaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Vendor Delivery" };
export const dynamic = "force-dynamic";

function Sig({ url, label }: { url: string | null; label: string }) {
  if (!url) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} className="h-20 rounded border bg-white object-contain" />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

export default async function VendorTransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProfile();

  const supabase = await createClient();
  const { data: txRow } = await supabase.from("vendor_transactions").select("*").eq("id", id).single();
  if (!txRow) notFound();
  const transaction = txRow as VendorTransaction;

  const [partARes, partBRes, partCRes] = await Promise.all([
    supabase.from("vendor_part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("vendor_part_b").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("vendor_part_c").select("*").eq("transaction_id", id).maybeSingle(),
  ]);
  const partA = partARes.data as VendorPartA | null;
  const partB = partBRes.data as VendorPartB | null;
  const partC = partCRes.data as VendorPartC | null;

  const [sigA, sigB, sigWarehouse, sigVendor, completedFormUrl] = await Promise.all([
    signedUrl("signatures", partA?.signature_url ?? null),
    signedUrl("signatures", partB?.signature_url ?? null),
    signedUrl("signatures", partC?.warehouse_signature_url ?? null),
    signedUrl("signatures", partC?.vendor_signature_url ?? null),
    signedUrl("completed-forms", transaction.completed_form_url),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            {transaction.transaction_number}
          </h1>
          <Badge className={VENDOR_STATUS_COLORS[transaction.status]}>
            {VENDOR_STATUS_LABELS[transaction.status]}
          </Badge>
        </div>
        {completedFormUrl ? (
          <a href={completedFormUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">
              <FileDown className="mr-1.5 h-4 w-4" />
              Completed Form (PDF)
            </Button>
          </a>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR Pass</CardTitle>
          </CardHeader>
          <CardContent>
            <QrDisplay
              token={generateQrToken(transaction.id, "VENDOR")}
              transactionNumber={transaction.transaction_number}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <Row label="Created" value={formatDateTime(transaction.created_at)} />
            <Row label="Completed" value={formatDateTime(transaction.completed_at)} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {partA ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part A — Vendor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Driver" value={partA.driver_name} />
              <Row label="NRIC" value={partA.nric_number} />
              <Row label="Seal Number" value={partA.seal_number} />
              <Row label="Completed" value={formatDateTime(partA.completed_at)} />
              <Sig url={sigA} label="Vendor Driver signature" />
            </CardContent>
          </Card>
        ) : null}

        {partB ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part B — AirAsia Security (Post 2)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Vehicle Reg. No" value={partB.vehicle_registration_no} />
              <Row label="Driver" value={`${partB.driver_name} (${partB.driver_nric})`} />
              <Row label="Seal Number" value={partB.seal_number} />
              <Row label="ASO" value={`${partB.avsec_name} (${partB.avsec_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partB.completed_at)} />
              {partB.remarks ? (
                <p className="text-sm text-muted-foreground">“{partB.remarks}”</p>
              ) : null}
              <Sig url={sigB} label="ASO signature" />
            </CardContent>
          </Card>
        ) : null}

        {partC ? (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                Part C — Warehouse (In-Flight), Dual Certification
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                <Row label="Warehouse PIC" value={partC.warehouse_pic_name ?? "—"} />
                <Row label="Signed At" value={formatDateTime(partC.warehouse_signed_at)} />
                <Sig url={sigWarehouse} label="Warehouse PIC signature" />
              </div>
              <div className="space-y-3">
                <Row label="Vendor Driver" value={partC.vendor_driver_name ?? "—"} />
                <Row label="Signed At" value={formatDateTime(partC.vendor_signed_at)} />
                <Sig url={sigVendor} label="Vendor Driver signature" />
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
