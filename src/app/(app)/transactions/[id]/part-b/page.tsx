import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { getLang } from "@/lib/actions/language";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/workflow";
import { CheckpointForm } from "@/components/checkpoint-form";
import { DirectionBadge } from "@/components/direction-badge";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { CheckpointContext } from "@/components/checkpoint-context";
import { Card, CardContent } from "@/components/ui/card";
import type { DriverRecord, PartA, PartBC, Seal, Transaction, VehicleRecord } from "@/lib/database.types";

export const metadata: Metadata = { title: "Part B — In-flight Security Post" };
export const dynamic = "force-dynamic";

export default async function PartBPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireRole(["post2_avsec"]);

  if (!profile.name.trim() || !profile.staff_id.trim()) {
    return (
      <div className="mx-auto max-w-lg">
        <Card className="border-red-300 dark:border-red-900">
          <CardContent className="pt-6 text-sm font-medium text-red-700 dark:text-red-300">
            Your profile is missing your name or badge ID, so this checkpoint form cannot be
            filled in on your behalf. Please contact Admin to complete your profile before
            continuing. / Profil anda tiada nama atau ID lencana; borang pusat pemeriksaan ini
            tidak boleh diisi bagi pihak anda. Sila hubungi Admin untuk melengkapkan profil anda
            sebelum meneruskan.
          </CardContent>
        </Card>
      </div>
    );
  }

  const supabase = await createClient();
  const { data: tx } = await supabase.from("transactions").select("*").eq("id", id).single();
  if (!tx) notFound();
  const transaction = tx as Transaction;

  const step = getStep(transaction.direction, "part_b");
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/transactions/${id}`);
  }

  const [sealRes, partARes, partCRes, vehiclesRes, driversRes] = await Promise.all([
    supabase
      .from("seals")
      .select("id, seal_number, seal_type, seal_color")
      .eq("transaction_id", id)
      .order("applied_at"),
    supabase.from("part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_c").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("vehicles").select("vehicle_number").eq("is_active", true),
    supabase.from("drivers").select("staff_id").eq("is_active", true),
  ]);
  const seals = (sealRes.data ?? []) as Pick<
    Seal,
    "id" | "seal_number" | "seal_type" | "seal_color"
  >[];
  const vehicles = (vehiclesRes.data ?? []) as Pick<VehicleRecord, "vehicle_number">[];
  const drivers = (driversRes.data ?? []) as Pick<DriverRecord, "staff_id">[];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{step.label}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <DirectionBadge direction={transaction.direction} />
          <span className="font-mono text-sm text-muted-foreground">
            {transaction.transaction_number}
          </span>
        </div>
        {step.finalizes ? (
          <p className="rounded-md bg-green-100 p-2 text-sm font-medium text-green-800 dark:bg-green-900/40 dark:text-green-200">
            Final checkpoint — approving here completes this inbound transaction.
          </p>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <WorkflowStepper
            direction={transaction.direction}
            status={transaction.status}
            parts={partsDoneFromStatus(transaction.direction, transaction.status)}
          />
        </CardContent>
      </Card>

      <CheckpointContext
        transaction={transaction}
        partA={partARes.data as PartA | null}
        partC={partCRes.data as PartBC | null}
      />

      <CheckpointForm
        part="part_b"
        transaction={transaction}
        seals={seals}
        vehicles={vehicles}
        drivers={drivers}
        officerName={profile.name}
        officerStaffId={profile.staff_id}
        finalizes={step.finalizes}
        lang={await getLang()}
      />
    </div>
  );
}
