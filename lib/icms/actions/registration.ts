"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { UserRole, ProfileStatus } from "@/lib/avsec/reference-data";

export interface RegisterState {
  error: string | null;
  success: string | null;
}

export interface ApprovalState {
  error: string | null;
}

export async function registerUser(_prev: RegisterState, formData: FormData): Promise<RegisterState> {
  const systemType = String(formData.get("system_type") ?? "avsec");
  const name = String(formData.get("name") ?? "").trim();
  const staffId = String(formData.get("staff_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  // AVSEC Specific fields
  const avsecRole = String(formData.get("avsec_role") ?? "SO").toUpperCase();
  const opsGroup = String(formData.get("ops_group") ?? "operation_avsec");
  const team = String(formData.get("team") ?? "ALPHA").toUpperCase();
  const station = String(formData.get("station") ?? "KUL - MAA");

  // Driver / CaterLink Specific fields
  const driverType = String(formData.get("driver_type") ?? "driver_vendor");
  const vendorCompany = String(formData.get("vendor_company") ?? "").trim();
  const vehiclePlate = String(formData.get("vehicle_plate") ?? "").trim().toUpperCase();

  if (!name || !staffId || !email) {
    return { error: "Full Name, Staff/Driver ID, and Email are required.", success: null };
  }
  if (!phone) {
    return { error: "Phone number is required for verification.", success: null };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters.", success: null };
  }

  try {
    const supabase = await createClient();

    const unifiedRole =
      systemType === "caterlink"
        ? "vendor"
        : (avsecRole.toLowerCase() as "admin" | "management" | "enforcement" | "so" | "aso" | "dse" | "vendor");

    const { data: created, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          full_name: name,
          staff_id: staffId,
          phone,
          system_type: systemType,
          role: systemType === "caterlink" ? "vendor" : avsecRole,
          unified_role: unifiedRole,
          ops_group: opsGroup,
          team,
          station,
          driver_type: driverType,
          vendor_company: vendorCompany,
          vehicle_plate: vehiclePlate,
        },
      },
    });

    if (authError || !created.user) {
      return { error: authError?.message ?? "Could not create account.", success: null };
    }

    if (systemType === "avsec") {
      // Insert into AVSEC profiles table with 'pending' status
      const { error: profileError } = await supabase.from("profiles").upsert(
        {
          id: created.user.id,
          email,
          name,
          staff_no: staffId,
          role: avsecRole as UserRole,
          unified_role: unifiedRole,
          ops_group: opsGroup,
          team,
          station,
          status: "pending" as ProfileStatus,
        },
        { onConflict: "id" }
      );

      if (profileError) {
        console.error("[registerUser] AVSEC profile insert note:", profileError.message);
      }
    } else {
      // Insert into ICMS users table with 'pending' status
      const { error: userError } = await supabase.from("users").upsert(
        {
          id: created.user.id,
          name,
          staff_id: staffId,
          email,
          role: "vendor",
          unified_role: "vendor",
          status: "pending",
        },
        { onConflict: "id" }
      );

      if (userError) {
        console.error("[registerUser] Driver user insert note:", userError.message);
      }
    }

    return {
      error: null,
      success: `Registration submitted successfully for ${systemType === "avsec" ? "VECTA (AirAsia AVSEC)" : "CATERLINK (Catering Movement)"}! Your account is now pending approval from an Administrator. You will be able to sign in once approved.`,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to register account",
      success: null,
    };
  }
}

export async function approveStaff(_prev: ApprovalState, formData: FormData): Promise<ApprovalState> {
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { error: "User ID is required." };

  try {
    const supabase = await createClient();
    await Promise.all([
      supabase.from("users").update({ status: "active" }).eq("id", userId),
      supabase.from("profiles").update({ status: "approved" as ProfileStatus }).eq("id", userId),
    ]);

    revalidatePath("/icms/admin/users");
    revalidatePath("/avsec/admin/users");
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to approve account" };
  }
}

export async function rejectStaff(_prev: ApprovalState, formData: FormData): Promise<ApprovalState> {
  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { error: "User ID is required." };

  try {
    const supabase = await createClient();
    await Promise.all([
      supabase.from("users").update({ status: "rejected" }).eq("id", userId),
      supabase.from("profiles").update({ status: "rejected" as ProfileStatus }).eq("id", userId),
    ]);

    revalidatePath("/icms/admin/users");
    revalidatePath("/avsec/admin/users");
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to reject account" };
  }
}
