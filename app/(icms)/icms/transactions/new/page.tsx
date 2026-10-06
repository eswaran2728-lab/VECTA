import type { Metadata } from "next";
import { isModuleMissing } from "@/lib/icms/module-state";
import { ModuleNotActivated } from "@/components/icms/ModuleNotActivated";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { callCaterlinkRpc } from "@/lib/caterlink/vendor";
import { PartAForm } from "./part-a-form";
import type { CateringCompany, DriverRecord, VehicleRecord } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "New Transaction (Part A)" };
export const dynamic = "force-dynamic";

interface DriverOptions {
  stations: string[];
  companies: { id: string; name: string; code: string }[];
  vehicles: { vehicle_number: string; pass_expiry_date: string | null }[];
  drivers: { name: string; staff_id: string; pass_expiry_date: string | null; catering_company_id: string | null }[];
}

export default async function NewTransactionPage() {
  const profile = await requireRole(["warehouse_pic"]);

  // The Driver cannot read the whitelist tables directly; this RPC returns only the currently usable
  // entries for the stations that may create movements.
  const supabase = await createClient();
  const { data, error: optionsError } = await callCaterlinkRpc(supabase, "list_caterlink_driver_options_secure", {});
  if (isModuleMissing(optionsError)) {
    return <ModuleNotActivated title="New Transaction" detail="Creating a transaction is not activated on this environment yet." />;
  }
  const options = (data ?? { stations: [], companies: [], vehicles: [], drivers: [] }) as DriverOptions;

  // The signed-in PIC is usually the one driving too — if their staff ID matches a whitelisted driver
  // record, default the form to "it's me" instead of making them retype their own name/ID/company.
  const ownDriverRecord =
    options.drivers.find((d) => d.staff_id.toUpperCase() === profile.staff_id.toUpperCase()) ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight">New Transaction</h1>
        <p className="text-sm text-muted-foreground">
          Choose the direction, then complete the vehicle search and seal the load. A transaction
          number is generated on submit.
        </p>
      </div>
      <PartAForm
        picName={profile.name}
        picStaffId={profile.staff_id}
        stations={options.stations}
        companies={options.companies as unknown as CateringCompany[]}
        vehicles={options.vehicles as Pick<VehicleRecord, "vehicle_number" | "pass_expiry_date">[]}
        drivers={options.drivers as Pick<DriverRecord, "name" | "staff_id" | "pass_expiry_date" | "catering_company_id">[]}
        ownDriverRecord={ownDriverRecord as Pick<DriverRecord, "name" | "staff_id" | "pass_expiry_date" | "catering_company_id"> | null}
      />
    </div>
  );
}
