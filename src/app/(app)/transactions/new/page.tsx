import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PartAForm } from "./part-a-form";
import type { CateringCompany, DriverRecord, VehicleRecord } from "@/lib/database.types";

export const metadata: Metadata = { title: "New Transaction (Part A)" };
export const dynamic = "force-dynamic";

export default async function NewTransactionPage() {
  const profile = await requireRole(["warehouse_pic", "sra_warehouse_pic"]);

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
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight">New Transaction</h1>
        <p className="text-sm text-muted-foreground">
          Choose the direction, then complete the vehicle search and seal the load. A transaction
          number and QR pass are generated on submit.
        </p>
      </div>
      <PartAForm
        picName={profile.name}
        picStaffId={profile.staff_id}
        companies={(companies.data ?? []) as CateringCompany[]}
        vehicles={(vehicles.data ?? []) as Pick<VehicleRecord, "vehicle_number" | "pass_expiry_date">[]}
        drivers={
          (drivers.data ?? []) as Pick<DriverRecord, "name" | "driver_id" | "pass_expiry_date">[]
        }
      />
    </div>
  );
}
