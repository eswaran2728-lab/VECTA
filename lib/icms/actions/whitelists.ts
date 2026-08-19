"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import type { TruckType } from "@/lib/icms/database.types";

export interface WhitelistActionState {
  error: string | null;
  success: string | null;
}

const PATH = "/admin/whitelists";

function s(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

export async function addCompany(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const name = s(fd, "name");
  const code = s(fd, "code").toUpperCase();
  if (!name || !code) return { error: "Name and code are required.", success: null };

  const supabase = await createClient();
  const { error } = await supabase.from("catering_companies").insert({ name, code });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Company ${name} added.` };
}

const TRUCK_TYPES: TruckType[] = ["Hi-Lift", "Bonded Truck"];

export async function addVehicle(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const vehicleNumber = s(fd, "vehicle_number").toUpperCase();
  if (!vehicleNumber) return { error: "Vehicle number is required.", success: null };

  const truckType = s(fd, "truck_type");
  if (!TRUCK_TYPES.includes(truckType as TruckType)) {
    return { error: "Select a truck type.", success: null };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("vehicles").insert({
    vehicle_number: vehicleNumber,
    catering_company_id: s(fd, "catering_company_id") || null,
    airport_pass_number: s(fd, "airport_pass_number") || null,
    pass_expiry_date: s(fd, "pass_expiry_date") || null,
    truck_type: truckType as TruckType,
    truck_registration_number: s(fd, "truck_registration_number") || null,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Vehicle ${vehicleNumber} added.` };
}

const IC_FORMAT = /^\d{6}-\d{2}-\d{4}$/;

export async function addDriver(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const name = s(fd, "name");
  const staffId = s(fd, "staff_id").toUpperCase();
  if (!name || !staffId) return { error: "Name and staff ID are required.", success: null };

  const swapToStaffIc = fd.get("swap_to_staff_ic") === "on";
  const staffIcNumber = s(fd, "staff_ic_number");
  if (swapToStaffIc && !IC_FORMAT.test(staffIcNumber)) {
    return {
      error: "Staff IC number must be in the format XXXXXX-XX-XXXX.",
      success: null,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("drivers").insert({
    name,
    staff_id: staffId,
    catering_company_id: s(fd, "catering_company_id") || null,
    airport_pass_number: s(fd, "airport_pass_number") || null,
    pass_expiry_date: s(fd, "pass_expiry_date") || null,
    swap_to_staff_ic: swapToStaffIc,
    staff_ic_number: swapToStaffIc ? staffIcNumber : null,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Driver ${name} added.` };
}

/** Soft-activate/deactivate a whitelist row (no hard deletes anywhere). */
export async function toggleWhitelistRow(fd: FormData): Promise<void> {
  await requireRole(["supervisor"]);
  const table = s(fd, "table");
  const id = s(fd, "id");
  const active = s(fd, "active") === "true";
  if (!["catering_companies", "vehicles", "drivers"].includes(table) || !id) return;

  const supabase = await createClient();
  await supabase
    .from(table as "catering_companies" | "vehicles" | "drivers")
    .update({ is_active: active })
    .eq("id", id);
  revalidatePath(PATH);
}

/**
 * Permanently delete a vehicle or driver whitelist row. Only possible when
 * no transaction references it — the FK on transactions.vehicle_id /
 * driver_id_ref (ON DELETE NO ACTION) rejects the delete otherwise, which
 * we surface as a friendly "deactivate instead" message rather than a raw
 * Postgres error. Deactivation (toggleWhitelistRow) remains the default,
 * audit-preserving way to retire a row; this is for rows that never had
 * any real activity (e.g. data entered in error).
 */
export async function deleteWhitelistRow(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const table = s(fd, "table");
  const id = s(fd, "id");
  const label = s(fd, "label") || "record";
  if (!["vehicles", "drivers"].includes(table) || !id) {
    return { error: "Invalid delete request.", success: null };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from(table as "vehicles" | "drivers")
    .delete()
    .eq("id", id);
  if (error) {
    const blockedByHistory = error.code === "23503";
    return {
      error: blockedByHistory
        ? `Cannot delete ${label} — it has transaction history. Deactivate it instead.`
        : error.message,
      success: null,
    };
  }
  revalidatePath(PATH);
  return { error: null, success: `${label} deleted.` };
}

/** Update a vehicle's or driver's pass expiry date. */
export async function updatePassExpiry(fd: FormData): Promise<void> {
  await requireRole(["supervisor"]);
  const table = s(fd, "table");
  const id = s(fd, "id");
  const date = s(fd, "pass_expiry_date");
  if (!["vehicles", "drivers"].includes(table) || !id) return;

  const supabase = await createClient();
  await supabase
    .from(table as "vehicles" | "drivers")
    .update({ pass_expiry_date: date || null })
    .eq("id", id);
  revalidatePath(PATH);
}
