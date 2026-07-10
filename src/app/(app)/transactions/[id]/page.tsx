import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import { QrDisplay } from "@/components/qr-display";
import { StatusBadge } from "@/components/status-badge";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { nextStepFor } from "@/lib/workflow";
import {
  DELIVERY_LOCATION_LABELS,
  INCIDENT_TYPE_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  SEAL_COLOR_BADGES,
  SEAL_COLOR_LABELS,
  SEAL_TYPE_LABELS,
} from "@/lib/constants";
import type {
  Incident,
  PartA,
  PartBC,
  PartD,
  Seal,
  SealVerification,
  Transaction,
} from "@/lib/database.types";

export const metadata: Metadata = { title: "Transaction" };
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

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  );
}

export default async function TransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; approved?: string; completed?: string; escalated?: string }>;
}) {
  const { id } = await params;
  const flags = await searchParams;
  const profile = await requireProfile();
  const supabase = await createClient();

  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const [a, b, c, d, inc, sealRes] = await Promise.all([
    supabase.from("part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_b").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_c").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_d").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("incidents").select("*").eq("transaction_id", id).order("created_at"),
    supabase
      .from("seals")
      .select("*, seal_verifications(*)")
      .eq("transaction_id", id)
      .order("applied_at"),
  ]);

  const partA = a.data as PartA | null;
  const partB = b.data as PartBC | null;
  const partC = c.data as PartBC | null;
  const partD = d.data as PartD | null;
  const incidents = (inc.data ?? []) as Incident[];
  const seals = (sealRes.data ?? []) as unknown as (Seal & {
    seal_verifications: SealVerification[];
  })[];

  const [sigA, sigB, sigC, sigD] = await Promise.all([
    signedUrl("signatures", partA?.signature_url ?? null),
    signedUrl("signatures", partB?.signature_url ?? null),
    signedUrl("signatures", partC?.signature_url ?? null),
    signedUrl("signatures", partD?.signature_url ?? null),
  ]);
  const incidentPhotos = await Promise.all(
    incidents.map((i) => signedUrl("incident-photos", i.photo_url))
  );

  // Which checkpoint can this user action right now? (direction-aware)
  const nextStep = nextStepFor(transaction.direction, transaction.status);
  const nextAction =
    nextStep && profile.role === nextStep.role
      ? {
          href: `/transactions/${id}/${nextStep.slug}`,
          label: `Complete ${nextStep.shortLabel}`,
        }
      : null;

  const banner = flags.created
    ? "Transaction created. Print or show the QR pass at Post 2."
    : flags.approved
      ? "Checkpoint recorded."
      : flags.completed
        ? "Delivery confirmed — transaction completed."
        : flags.escalated
          ? "Incident reported. Transaction escalated and supervisor notified."
          : null;

  return (
    <div className="space-y-4">
      {banner ? (
        <p
          className={`rounded-md p-3 text-sm font-medium ${
            flags.escalated
              ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          }`}
        >
          {banner}
        </p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            {transaction.transaction_number}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={transaction.status} />
            <DirectionBadge direction={transaction.direction} />
          </div>
        </div>
        <div className="flex gap-2">
          {nextAction ? (
            <Link href={nextAction.href}>
              <Button size="lg">{nextAction.label}</Button>
            </Link>
          ) : null}
          {transaction.status !== "COMPLETED" || profile.role === "supervisor" ? (
            <Link href={`/transactions/${id}/incident`}>
              <Button variant="destructive" size="lg">
                Report Incident
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consignment</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Vehicle" value={<span className="font-mono">{transaction.vehicle_number}</span>} />
            <Row label="Driver" value={transaction.driver_name} />
            <Row label="Driver ID" value={<span className="font-mono">{transaction.driver_id}</span>} />
            <Row label="Created" value={formatDateTime(transaction.created_at)} />
            <Row label="Completed" value={formatDateTime(transaction.completed_at)} />
            <div className="space-y-2 pt-2">
              <p className="text-sm text-muted-foreground">Seals ({seals.length})</p>
              {seals.map((seal) => (
                <div key={seal.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={SEAL_COLOR_BADGES[seal.seal_color]}>
                    {SEAL_COLOR_LABELS[seal.seal_color]} {SEAL_TYPE_LABELS[seal.seal_type]}
                  </Badge>
                  <span className="font-mono font-medium">{seal.seal_number}</span>
                  {seal.seal_verifications.length > 0 ? (
                    <span
                      className={`text-xs ${
                        seal.seal_verifications.every((v) => v.matched)
                          ? "text-emerald-600"
                          : "font-semibold text-red-600"
                      }`}
                    >
                      {seal.seal_verifications.filter((v) => v.matched).length}/
                      {seal.seal_verifications.length} checks matched
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">not yet verified</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">QR Pass</CardTitle>
          </CardHeader>
          <CardContent>
            <QrDisplay
              transactionId={transaction.id}
              transactionNumber={transaction.transaction_number}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workflow Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkflowStepper
              direction={transaction.direction}
              status={transaction.status}
              parts={{ part_b: !!partB, part_c: !!partC, part_d: !!partD }}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {partA ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part A — Warehouse PIC</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="PIC" value={`${partA.pic_name} (${partA.pic_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partA.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partA.vehicle_search_completed} label="Vehicle search" />
              </div>
              {partA.remarks ? <p className="text-sm text-muted-foreground">“{partA.remarks}”</p> : null}
              <Sig url={sigA} label="PIC signature" />
            </CardContent>
          </Card>
        ) : null}

        {partB ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part B — AVSEC Post 2</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Officer" value={`${partB.avsec_name} (${partB.avsec_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partB.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partB.vehicle_verified} label="Vehicle" />
                <Check ok={partB.driver_verified} label="Driver" />
                <Check ok={partB.seal_verified} label="Seal" />
              </div>
              {partB.remarks ? <p className="text-sm text-muted-foreground">“{partB.remarks}”</p> : null}
              <Sig url={sigB} label="Officer signature" />
            </CardContent>
          </Card>
        ) : null}

        {partC ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part C — AVSEC Post 6</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Officer" value={`${partC.avsec_name} (${partC.avsec_staff_id})`} />
              <Row label="Completed" value={formatDateTime(partC.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partC.vehicle_verified} label="Vehicle" />
                <Check ok={partC.driver_verified} label="Driver" />
                <Check ok={partC.seal_verified} label="Seal" />
              </div>
              {partC.remarks ? <p className="text-sm text-muted-foreground">“{partC.remarks}”</p> : null}
              <Sig url={sigC} label="Officer signature" />
            </CardContent>
          </Card>
        ) : null}

        {partD ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Part D — Delivery</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row
                label="Receiver"
                value={`${partD.receiver_name} (${partD.receiver_staff_id})`}
              />
              <Row label="Location" value={DELIVERY_LOCATION_LABELS[partD.delivery_location]} />
              <Row label="Completed" value={formatDateTime(partD.completed_at)} />
              <div className="flex flex-wrap gap-2">
                <Check ok={partD.seal_intact} label="Seal intact" />
              </div>
              {partD.remarks ? <p className="text-sm text-muted-foreground">“{partD.remarks}”</p> : null}
              <Sig url={sigD} label="Receiver signature" />
            </CardContent>
          </Card>
        ) : null}
      </div>

      {incidents.length > 0 ? (
        <Card className="border-red-300 dark:border-red-900">
          <CardHeader>
            <CardTitle className="text-base text-red-700 dark:text-red-300">
              Incidents ({incidents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incidents.map((incident, i) => (
              <div key={incident.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    {INCIDENT_TYPE_LABELS[incident.incident_type]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(incident.created_at)} · {incident.reported_by}
                  </span>
                </div>
                <p className="mt-1 text-sm">{incident.description}</p>
                {incidentPhotos[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={incidentPhotos[i]!}
                    alt="Incident evidence"
                    className="mt-2 max-h-56 rounded border object-contain"
                  />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
