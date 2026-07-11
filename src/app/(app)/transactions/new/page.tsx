import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CREATOR_DIRECTIONS, WORKFLOWS } from "@/lib/workflow";
import { DirectionBadge } from "@/components/direction-badge";
import { PartAForm } from "./part-a-form";
import type { CateringCompany, DriverRecord, VehicleRecord } from "@/lib/database.types";

export const metadata: Metadata = { title: "New Transaction (Part A)" };
export const dynamic = "force-dynamic";

export default async function NewTransactionPage() {
  const profile = await requireRole(["warehouse_pic", "sra_warehouse_pic"]);
  const direction = CREATOR_DIRECTIONS[profile.role]!;
  const flow = ["A · Warehouse", ...WORKFLOWS[direction].map((s) => s.shortLabel)].join("  →  ");

  const supabase = await createClient();
  const [companies, vehicles, drivers] = await Promise.all([
    supabase.from("catering_companies").select("*").eq("is_active", true).order("name"),
    supabase
      .from("vehicles")
      .select("vehicle_number, pass_expiry_date")
      .eq("is_active", true)
      .order("vehicle_number"),
    supabase
      .from("drivers")
      .select("name, driver_id, pass_expiry_date")
      .eq("is_active", true)
      .order("name"),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Part A — {direction === "OUTBOUND" ? "Warehouse Dispatch" : "SRA Warehouse Dispatch"}
        </h1>
        <DirectionBadge direction={direction} />
        <p className="text-sm text-muted-foreground">
          Complete the vehicle search and seal the load. A transaction number and QR pass are
          generated on submit.
        </p>
        <p className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
          {flow}
        </p>
      </div>
      <PartAForm
        picName={profile.name}
        picStaffId={profile.staff_id}
        direction={direction}
        companies={(companies.data ?? []) as CateringCompany[]}
        vehicles={(vehicles.data ?? []) as Pick<VehicleRecord, "vehicle_number" | "pass_expiry_date">[]}
        drivers={
          (drivers.data ?? []) as Pick<DriverRecord, "name" | "driver_id" | "pass_expiry_date">[]
        }
      />
    </div>
  );
}
