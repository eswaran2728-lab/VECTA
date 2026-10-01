"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { TruckType } from "@/lib/icms/database.types";

export interface WhitelistActionState {
  error: string | null;
  success: string | null;
}

const PATH = "/icms/admin/whitelists";

function s(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

/**
 * Phase 9 whitelist authorization gate: an active `caterlink_management`
 * assignment in the caller's AOC (Phase 3 scoped-role model, via
 * auth.uid()) -- never the legacy ICMS `public.users.role` system that
 * every other page on this app still uses. The whitelist RPCs
 * (list/create/approve/reject/activate/deactivate_caterlink_whitelist_
 * entry_secure) enforce this same check again server-side regardless, so
 * this call is what turns "no active assignment" into a clean redirect
 * instead of every list/mutation call individually failing.
 */
async function requireCaterlinkManagement() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { supabase, aocId: null as string | null, authorized: false as const };
  }
  const { data: aocId } = await supabase.rpc("my_aoc_id");
  if (!aocId) {
    return { supabase, aocId: null as string | null, authorized: false as const };
  }
  const { data: authorized } = await supabase.rpc("has_active_role_for_aoc", {
    p_role_code: "caterlink_management",
    p_aoc_id: aocId,
  });
  return { supabase, aocId: aocId as string, authorized: authorized === true };
}

export interface WhitelistEntry {
  entry_type: "vendor" | "vehicle" | "driver";
  id: string;
  aoc_id: string;
  operating_entity_id: string | null;
  display_name: string;
  identifier: string;
  company_name: string | null;
  status: "pending" | "active" | "inactive" | "rejected" | "deactivated" | "revoked" | "expired" | "future";
  pass_expiry_date: string | null;
  effective_from: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  deactivated_by: string | null;
  deactivated_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhitelistListResult {
  entries: WhitelistEntry[];
  error: string | null;
  unauthorized: boolean;
}

/** List/search/filter -- the single authoritative read path for the admin page. */
export async function listWhitelistEntries(filters: {
  entryType?: string;
  status?: string;
  search?: string;
}): Promise<WhitelistListResult> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return { entries: [], error: null, unauthorized: true };

  const { data, error } = await supabase.rpc("list_caterlink_whitelist_secure", {
    p_entry_type: filters.entryType || null,
    p_status: filters.status || null,
    p_search: filters.search || null,
  });
  if (error) return { entries: [], error: error.message, unauthorized: false };
  return { entries: (data ?? []) as WhitelistEntry[], error: null, unauthorized: false };
}

export interface VendorOption {
  id: string;
  display_name: string;
}

/** Active vendors in the caller's AOC, for the catering-company picker on vehicle/driver forms. */
export async function listVendorOptions(): Promise<VendorOption[]> {
  const { authorized } = await requireCaterlinkManagement();
  if (!authorized) return [];
  const { entries } = await listWhitelistEntries({ entryType: "vendor", status: "active" });
  return entries.map((e) => ({ id: e.id, display_name: e.display_name }));
}

export async function addCompany(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, aocId, authorized } = await requireCaterlinkManagement();
  if (!authorized || !aocId) {
    return { error: "You must hold an active CaterLink Management assignment to do this.", success: null };
  }
  const name = s(fd, "name");
  const code = s(fd, "code").toUpperCase();
  if (!name || !code) return { error: "Name and code are required.", success: null };

  const { error } = await supabase.rpc("create_caterlink_whitelist_entry_secure", {
    p_entry_type: "vendor",
    p_aoc_id: aocId,
    p_name: name,
    p_code: code,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Vendor ${name} submitted for approval.` };
}

const TRUCK_TYPES: TruckType[] = ["Hi-Lift", "Bonded Truck"];

export async function addVehicle(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, aocId, authorized } = await requireCaterlinkManagement();
  if (!authorized || !aocId) {
    return { error: "You must hold an active CaterLink Management assignment to do this.", success: null };
  }
  const vehicleNumber = s(fd, "vehicle_number").toUpperCase();
  if (!vehicleNumber) return { error: "Vehicle number is required.", success: null };

  const truckType = s(fd, "truck_type");
  if (!TRUCK_TYPES.includes(truckType as TruckType)) {
    return { error: "Select a truck type.", success: null };
  }

  const { error } = await supabase.rpc("create_caterlink_whitelist_entry_secure", {
    p_entry_type: "vehicle",
    p_aoc_id: aocId,
    p_identifier: vehicleNumber,
    p_catering_company_id: s(fd, "catering_company_id") || null,
    p_airport_pass_number: s(fd, "airport_pass_number") || null,
    p_pass_expiry_date: s(fd, "pass_expiry_date") || null,
    p_truck_type: truckType,
    p_truck_registration_number: s(fd, "truck_registration_number") || null,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Vehicle ${vehicleNumber} submitted for approval.` };
}

const IC_FORMAT = /^\d{6}-\d{2}-\d{4}$/;

export async function addDriver(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, aocId, authorized } = await requireCaterlinkManagement();
  if (!authorized || !aocId) {
    return { error: "You must hold an active CaterLink Management assignment to do this.", success: null };
  }
  const name = s(fd, "name");
  const staffId = s(fd, "staff_id").toUpperCase();
  if (!name || !staffId) return { error: "Name and staff ID are required.", success: null };

  const swapToStaffIc = fd.get("swap_to_staff_ic") === "on";
  const staffIcNumber = s(fd, "staff_ic_number");
  if (swapToStaffIc && !IC_FORMAT.test(staffIcNumber)) {
    return { error: "Staff IC number must be in the format XXXXXX-XX-XXXX.", success: null };
  }

  const { error } = await supabase.rpc("create_caterlink_whitelist_entry_secure", {
    p_entry_type: "driver",
    p_aoc_id: aocId,
    p_name: name,
    p_identifier: staffId,
    p_catering_company_id: s(fd, "catering_company_id") || null,
    p_airport_pass_number: s(fd, "airport_pass_number") || null,
    p_pass_expiry_date: s(fd, "pass_expiry_date") || null,
    p_swap_to_staff_ic: swapToStaffIc,
    p_staff_ic_number: swapToStaffIc ? staffIcNumber : null,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: `Driver ${name} submitted for approval.` };
}

function entryTypeFromTable(table: string): "vendor" | "vehicle" | "driver" | null {
  if (table === "catering_companies") return "vendor";
  if (table === "vehicles") return "vehicle";
  if (table === "drivers") return "driver";
  return null;
}

export async function approveWhitelistEntry(fd: FormData): Promise<void> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return;
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  if (!entryType || !id) return;
  await supabase.rpc("approve_caterlink_whitelist_entry_secure", { p_entry_type: entryType, p_id: id });
  revalidatePath(PATH);
}

export async function rejectWhitelistEntry(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return { error: "Not authorized.", success: null };
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  const reason = s(fd, "reason");
  if (!entryType || !id) return { error: "Invalid request.", success: null };
  if (!reason) return { error: "A reason is required to reject an entry.", success: null };
  const { error } = await supabase.rpc("reject_caterlink_whitelist_entry_secure", {
    p_entry_type: entryType,
    p_id: id,
    p_reason: reason,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: "Entry rejected." };
}

export async function deactivateWhitelistEntry(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return { error: "Not authorized.", success: null };
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  const reason = s(fd, "reason");
  if (!entryType || !id) return { error: "Invalid request.", success: null };
  if (!reason) return { error: "A reason is required to deactivate an entry.", success: null };
  const { error } = await supabase.rpc("deactivate_caterlink_whitelist_entry_secure", {
    p_entry_type: entryType,
    p_id: id,
    p_reason: reason,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: "Entry deactivated." };
}

export async function activateWhitelistEntry(fd: FormData): Promise<void> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return;
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  if (!entryType || !id) return;
  await supabase.rpc("activate_caterlink_whitelist_entry_secure", { p_entry_type: entryType, p_id: id });
  revalidatePath(PATH);
}

/** Permanent, terminal revocation -- distinct from deactivate() (reversible). */
export async function revokeWhitelistEntry(
  _prev: WhitelistActionState,
  fd: FormData
): Promise<WhitelistActionState> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return { error: "Not authorized.", success: null };
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  const reason = s(fd, "reason");
  if (!entryType || !id) return { error: "Invalid request.", success: null };
  if (!reason) return { error: "A reason is required to revoke an entry.", success: null };
  const { error } = await supabase.rpc("revoke_caterlink_whitelist_entry_secure", {
    p_entry_type: entryType,
    p_id: id,
    p_reason: reason,
  });
  if (error) return { error: error.message, success: null };
  revalidatePath(PATH);
  return { error: null, success: "Entry revoked." };
}

/** Update a vehicle's or driver's pass expiry date (non-identity field; permitted post-approval). */
export async function updatePassExpiry(fd: FormData): Promise<void> {
  const { supabase, authorized } = await requireCaterlinkManagement();
  if (!authorized) return;
  const entryType = entryTypeFromTable(s(fd, "table"));
  const id = s(fd, "id");
  const date = s(fd, "pass_expiry_date");
  if (entryType !== "vehicle" && entryType !== "driver") return;
  if (!id) return;

  await supabase.rpc("update_caterlink_whitelist_pass_expiry_secure", {
    p_entry_type: entryType,
    p_id: id,
    p_pass_expiry_date: date || null,
  });
  revalidatePath(PATH);
}
