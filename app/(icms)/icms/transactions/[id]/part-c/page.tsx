import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireCheckpointRole } from "@/lib/icms/auth";
import { getLang } from "@/lib/icms/actions/language";
import { createClient } from "@/lib/supabase/server";
import { getStep, partsDoneFromStatus } from "@/lib/icms/workflow";
import { CheckpointForm } from "@/components/icms/checkpoint-form";
import { DirectionBadge } from "@/components/icms/direction-badge";
import { WorkflowStepper } from "@/components/icms/workflow-stepper";
import { CheckpointContext } from "@/components/icms/checkpoint-context";
import { Card, CardContent } from "@/components/icms/ui/card";
import type { DriverRecord, PartA, PartBC, Seal, Transaction, VehicleRecord } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Part C — Airport Security Post" };
export const dynamic = "force-dynamic";

export default async function PartCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireCheckpointRole("post6_avsec");

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

  const step = getStep(transaction.direction, "part_c", transaction.route);
  if (!step || transaction.status !== step.requiredStatus) {
    redirect(`/icms/transactions/${id}`);
  }

  const [sealRes, partARes, partBRes, vehiclesRes, driversRes] = await Promise.all([
    supabase
      .from("seals")
      .select("id, seal_number, seal_type, seal_color")
      .eq("transaction_id", id)
      .order("applied_at"),
    supabase.from("part_a").select("*").eq("transaction_id", id).maybeSingle(),
    supabase.from("part_b").select("*").eq("transaction_id", id).maybeSingle(),
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
      </div>

      <Card>
        <CardContent className="pt-6">
          <WorkflowStepper
            direction={transaction.direction}
            status={transaction.status}
            route={transaction.route}
            parts={partsDoneFromStatus(transaction.direction, transaction.status, transaction.route)}
          />
        </CardContent>
      </Card>

      <CheckpointContext
        transaction={transaction}
        partA={partARes.data as PartA | null}
        partB={partBRes.data as PartBC | null}
      />

      <CheckpointForm
        part="part_c"
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
