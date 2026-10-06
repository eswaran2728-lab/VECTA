import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/icms/storage";
import { generateQrToken } from "@/lib/icms/qr-token";
import { QrDisplay } from "@/components/icms/qr-display";
import { StatusBadge } from "@/components/icms/status-badge";
import { DirectionBadge } from "@/components/icms/direction-badge";
import { Badge } from "@/components/icms/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import {
  CARGO_TYPE_LABELS,
  DELIVERY_LOCATION_LABELS,
  HUB_DESTINATION_LABELS,
  INCIDENT_STATUS_COLORS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  ROUTE_LABELS,
  SEAL_COLOR_BADGES,
  SEAL_COLOR_LABELS,
  SEAL_TYPE_LABELS,
} from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import type { Incident, Seal, SealVerification, Transaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Transaction" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Canonical Phase 9 checkpoint rows (row-level security follows the parent transaction's visibility).
interface CheckpointBase {
  id: string;
  signature_url: string;
  remarks: string | null;
  completed_at: string;
}
interface PartARow extends CheckpointBase {
  pic_name: string;
  pic_staff_id: string;
  vehicle_search_completed: boolean;
}
interface PartBCRow extends CheckpointBase {
  checkpoint_stage: "B" | "C";
  avsec_name: string;
  avsec_staff_id: string;
  vehicle_verified: boolean;
  driver_verified: boolean;
  seal_verified: boolean;
  result: "PASS" | "ESCALATE";
  escalation_reason: string | null;
}
interface PartDRow extends CheckpointBase {
  delivery_location: "SRA_WAREHOUSE" | "AIRCRAFT";
  receiver_name: string;
  receiver_staff_id: string;
  seal_intact: boolean;
  result: "PASS" | "ESCALATE";
  escalation_reason: string | null;
  aircraft_identifier: string | null;
}
interface HubRow extends CheckpointBase {
  confirmed_destination: string;
  hub_avsec_name: string;
  hub_avsec_staff_id: string;
}
interface RedqRow extends CheckpointBase {
  redq_avsec_name: string;
  redq_avsec_staff_id: string;
}

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

function PartCard({
  title,
  rows,
  signature,
  signatureLabel,
  children,
}: {
  title: string;
  rows: [string, React.ReactNode][];
  signature: string | null;
  signatureLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map(([label, value]) => (
          <Row key={label} label={label} value={value} />
        ))}
        {children}
        <Sig url={signature} label={signatureLabel} />
      </CardContent>
    </Card>
  );
}

function PendingCard({ title }: { title: string }) {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Not recorded yet.</CardContent>
    </Card>
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
  // CaterLink Driver and Vendor are separate parties: this workflow belongs to the other one (and to Management/officers).
  if (profile.identity === "external" && profile.role === "vendor") redirect("/icms/dashboard?error=forbidden");
  const supabase = await createClient();

  // Row-level security decides visibility: the creating Driver, CaterLink Management / Operation Manager /
  // Main Enforcement in the AOC, or station staff. Anyone else gets a 404.
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).maybeSingle();
  if (!tx) notFound();
  const transaction = tx as unknown as Transaction;

  const [a, bc, d, hub, redq, inc, sealRes] = await Promise.all([
    supabase.from("caterlink_checkpoint_part_a" as never).select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_b_c" as never).select("*").eq("transaction_id", id),
    supabase.from("caterlink_checkpoint_part_d" as never).select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("caterlink_checkpoint_hub" as never).select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("caterlink_checkpoint_redq" as never).select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("caterlink_incidents" as never).select("*").eq("transaction_id", id).order("created_at"),
    supabase.from("seals").select("*, seal_verifications(*)").eq("transaction_id", id).order("applied_at"),
  ]);

  const partA = a.data as unknown as PartARow | null;
  const bcRows = (bc.data ?? []) as unknown as PartBCRow[];
  const partB = bcRows.find((r) => r.checkpoint_stage === "B") ?? null;
  const partC = bcRows.find((r) => r.checkpoint_stage === "C") ?? null;
  const partD = d.data as unknown as PartDRow | null;
  const partHub = hub.data as unknown as HubRow | null;
  const partRedq = redq.data as unknown as RedqRow | null;
  const incidents = (inc.data ?? []) as unknown as (Incident & { severity?: string })[];
  const seals = (sealRes.data ?? []) as unknown as (Seal & { seal_verifications: SealVerification[] })[];

  const [sigA, sigB, sigC, sigD, sigHub, sigRedq] = await Promise.all([
    signedUrl("signatures", partA?.signature_url ?? null),
    signedUrl("signatures", partB?.signature_url ?? null),
    signedUrl("signatures", partC?.signature_url ?? null),
    signedUrl("signatures", partD?.signature_url ?? null),
    signedUrl("signatures", partHub?.signature_url ?? null),
    signedUrl("signatures", partRedq?.signature_url ?? null),
  ]);

  const banner = flags.created
    ? "Transaction created. Show the QR pass at the security checkpoint."
    : flags.approved
      ? "Checkpoint recorded."
      : flags.completed
        ? "Delivery confirmed — transaction completed."
        : flags.escalated
          ? "Incident reported. Transaction escalated and admin notified."
          : null;

  return (
    <div className="space-y-4">
      {banner ? (
        <p className="rounded-md bg-emerald-100 p-3 text-sm font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{banner}</p>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="mb-0.5 block font-mono text-xs font-semibold uppercase tracking-wider text-primary">CATERING DISPATCH PASS</span>
          <h1 className="font-mono text-2xl font-bold tracking-tight">{transaction.transaction_number}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={transaction.status} />
            <DirectionBadge direction={transaction.direction} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">QR Pass</CardTitle>
          </CardHeader>
          <CardContent>
            <QrDisplay token={generateQrToken(transaction.id)} transactionNumber={transaction.transaction_number} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <Row label="Route" value={ROUTE_LABELS[transaction.route]} />
            {transaction.hub_destination ? <Row label="Hub destination" value={HUB_DESTINATION_LABELS[transaction.hub_destination]} /> : null}
            <Row label="Station" value={transaction.station ?? "—"} />
            <Row label="Vehicle" value={<span className="font-mono">{transaction.vehicle_number}</span>} />
            <Row label="Driver" value={`${transaction.driver_name} (${transaction.driver_id})`} />
            {transaction.flight_number ? <Row label="Flight" value={transaction.flight_number} /> : null}
            {transaction.aircraft_registration ? <Row label="Aircraft" value={transaction.aircraft_registration} /> : null}
            <Row label="Trolleys" value={transaction.trolley_count} />
            <Row
              label="Cargo"
              value={transaction.cargo_types.length > 0 ? transaction.cargo_types.map((c) => CARGO_TYPE_LABELS[c] ?? c).join(", ") : "—"}
            />
            <Row label="Created" value={formatDateTime(transaction.created_at)} />
            <Row label="Completed" value={formatDateTime(transaction.completed_at)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Seals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {seals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No seals recorded.</p>
          ) : (
            seals.map((s) => (
              <div key={s.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{s.seal_number}</span>
                  <Badge className={SEAL_COLOR_BADGES[s.seal_color]}>{SEAL_COLOR_LABELS[s.seal_color]}</Badge>
                  <span className="text-xs text-muted-foreground">{SEAL_TYPE_LABELS[s.seal_type]}</span>
                  {s.superseded_at ? <span className="text-xs text-amber-700">superseded</span> : null}
                </div>
                {s.seal_verifications.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.seal_verifications.map((v) => (
                      <Check key={v.id} ok={v.matched} label={`${v.checkpoint}: ${v.entered_seal_number}`} />
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {partA ? (
          <PartCard
            title="Part A — Dispatch (Driver)"
            rows={[
              ["PIC", `${partA.pic_name} (${partA.pic_staff_id})`],
              ["Vehicle search", <Check key="vs" ok={partA.vehicle_search_completed} label={partA.vehicle_search_completed ? "Completed" : "Not completed"} />],
              ["Completed", formatDateTime(partA.completed_at)],
            ]}
            signature={sigA}
            signatureLabel="PIC signature"
          >
            {partA.remarks ? <p className="text-sm text-muted-foreground">“{partA.remarks}”</p> : null}
          </PartCard>
        ) : (
          <PendingCard title="Part A — Dispatch (Driver)" />
        )}

        {partB ? (
          <PartCard
            title="Part B — Checkpoint"
            rows={[
              ["Officer", `${partB.avsec_name} (${partB.avsec_staff_id})`],
              ["Verified", <span key="v" className="flex flex-wrap justify-end gap-1"><Check ok={partB.vehicle_verified} label="Vehicle" /><Check ok={partB.driver_verified} label="Driver" /><Check ok={partB.seal_verified} label="Seal" /></span>],
              ["Result", partB.result],
              ["Completed", formatDateTime(partB.completed_at)],
            ]}
            signature={sigB}
            signatureLabel="Officer signature"
          >
            {partB.escalation_reason ? <p className="text-sm font-medium text-orange-700">Escalated: {partB.escalation_reason}</p> : null}
          </PartCard>
        ) : (
          <PendingCard title="Part B — Checkpoint" />
        )}

        {partC ? (
          <PartCard
            title="Part C — Checkpoint"
            rows={[
              ["Officer", `${partC.avsec_name} (${partC.avsec_staff_id})`],
              ["Verified", <span key="v" className="flex flex-wrap justify-end gap-1"><Check ok={partC.vehicle_verified} label="Vehicle" /><Check ok={partC.driver_verified} label="Driver" /><Check ok={partC.seal_verified} label="Seal" /></span>],
              ["Result", partC.result],
              ["Completed", formatDateTime(partC.completed_at)],
            ]}
            signature={sigC}
            signatureLabel="Officer signature"
          >
            {partC.escalation_reason ? <p className="text-sm font-medium text-orange-700">Escalated: {partC.escalation_reason}</p> : null}
          </PartCard>
        ) : (
          <PendingCard title="Part C — Checkpoint" />
        )}

        {partD ? (
          <PartCard
            title="Part D — Delivery"
            rows={[
              ["Location", DELIVERY_LOCATION_LABELS[partD.delivery_location]],
              ["Receiver", `${partD.receiver_name} (${partD.receiver_staff_id})`],
              ["Seal intact", <Check key="si" ok={partD.seal_intact} label={partD.seal_intact ? "Intact" : "Not intact"} />],
              ["Result", partD.result],
              ["Completed", formatDateTime(partD.completed_at)],
            ]}
            signature={sigD}
            signatureLabel="Receiver signature"
          />
        ) : transaction.route === "AIRCRAFT" ? (
          <PendingCard title="Part D — Delivery" />
        ) : null}

        {partHub ? (
          <PartCard
            title="Hub — Destination receipt"
            rows={[
              ["Destination", partHub.confirmed_destination],
              ["Officer", `${partHub.hub_avsec_name} (${partHub.hub_avsec_staff_id})`],
              ["Completed", formatDateTime(partHub.completed_at)],
            ]}
            signature={sigHub}
            signatureLabel="Officer signature"
          />
        ) : transaction.route === "HUB" ? (
          <PendingCard title="Hub — Destination receipt" />
        ) : null}

        {partRedq ? (
          <PartCard
            title="REDQ — Reseal"
            rows={[
              ["Officer", `${partRedq.redq_avsec_name} (${partRedq.redq_avsec_staff_id})`],
              ["Completed", formatDateTime(partRedq.completed_at)],
            ]}
            signature={sigRedq}
            signatureLabel="Officer signature"
          />
        ) : null}
      </div>

      {incidents.length > 0 ? (
        <Card className="border-red-300 dark:border-red-900">
          <CardHeader>
            <CardTitle className="text-base text-red-700 dark:text-red-300">Incidents ({incidents.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incidents.map((incident) => (
              <div key={incident.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{INCIDENT_TYPE_LABELS[incident.incident_type]}</span>
                    <Badge className={INCIDENT_STATUS_COLORS[incident.status]}>{INCIDENT_STATUS_LABELS[incident.status]}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(incident.created_at)}</span>
                </div>
                <p className="text-sm">{incident.description}</p>
                {incident.resolution_notes ? (
                  <div className="rounded bg-muted/60 p-2 text-xs">
                    <span className="font-semibold text-muted-foreground">Resolution notes: </span>
                    <span className="text-foreground">“{incident.resolution_notes}”</span>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
