"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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

export async function addVehicle(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const vehicleNumber = s(fd, "vehicle_number").toUpperCase();
  if (!vehicleNumber) return { error: "Vehicle number is required.", success: null };

  const supabase = await createClient();
  const { error } = await supabase.from("vehicles").insert({
    vehicle_number: vehicleNumber,
    catering_company_id: s(fd, "catering_company_id") || null,
    airport_pass_number: s(fd, "airport_pass_number") || null,
    pass_expiry_date: s(fd, "pass_expiry_date") || null,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Vehicle ${vehicleNumber} added.` };
}

export async function addDriver(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  await requireRole(["supervisor"]);
  const name = s(fd, "name");
  const driverId = s(fd, "driver_id").toUpperCase();
  if (!name || !driverId) return { error: "Name and driver ID are required.", success: null };

  const supabase = await createClient();
  const { error } = await supabase.from("drivers").insert({
    name,
    driver_id: driverId,
    catering_company_id: s(fd, "catering_company_id") || null,
    airport_pass_number: s(fd, "airport_pass_number") || null,
    pass_expiry_date: s(fd, "pass_expiry_date") || null,
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
