"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/icms/auth";
import type { ProfileStatus } from "@/lib/avsec/reference-data";

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

    const mappedUnifiedRole =
      avsecRole.toLowerCase() === "admin" ? "management" : avsecRole.toLowerCase();
    const unifiedRole =
      systemType === "caterlink"
        ? "vendor"
        : (mappedUnifiedRole as "management" | "enforcement" | "so" | "aso" | "dse" | "vendor");

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
          role: systemType === "caterlink" ? "vendor" : (avsecRole === "ADMIN" ? "MANAGEMENT" : avsecRole),
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
      const safeRole = avsecRole === "ADMIN" ? "MANAGEMENT" : (avsecRole ?? "ASO");
      const { error: profileError } = await supabase.from("profiles").upsert(
        {
          id: created.user.id,
          email,
          name,
          staff_no: staffId,
          role: safeRole as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
          unified_role: unifiedRole,
          ops_group: opsGroup,
          team,
          station,
          status: "pending" as ProfileStatus,
        },
        { onConflict: "id" }
      );

      // Previously swallowed (console.error only, "success" still returned) --
      // a rejected write here means the auth account exists with no profile
      // row at all, so the account can never actually be approved or signed
      // into. Surface it instead.
      if (profileError) {
        return { error: `Could not create your profile: ${profileError.message}`, success: null };
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

      // Same as above -- previously swallowed. See the new
      // "users: self register pending vendor" RLS policy
      // (supabase/migrations) for what this write is now actually allowed
      // to do; anything outside that narrow allowlist correctly fails here.
      if (userError) {
        return { error: `Could not create your driver/vendor account: ${userError.message}`, success: null };
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
  // The page that renders the approve/reject buttons already gates on this
  // role, but a server action is its own reachable endpoint — without this
  // check here, any authenticated (even pending/unapproved) account could
  // call approveStaff directly with their own user_id and self-approve,
  // since the underlying RLS "self update" policies on users/profiles have
  // no column-level restriction blocking a status change on your own row.
  try {
    await requireRole(["supervisor"]);
  } catch {
    return { error: "Not authorized to approve accounts." };
  }

  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { error: "User ID is required." };

  try {
    const supabase = await createClient();
    const [usersResult, profilesResult] = await Promise.all([
      supabase.from("users").update({ status: "active" }).eq("id", userId).select("id"),
      supabase.from("profiles").update({ status: "approved" as ProfileStatus }).eq("id", userId).select("id"),
    ]);

    // Previously unchecked -- both writes need an RLS policy that actually
    // permits a supervisor to touch another user's row (users:
    // "users: supervisor approves pending"; profiles already had this via
    // "profiles management approve pending"). A rejected/zero-row write
    // silently reported success with nothing actually approved.
    if (usersResult.error) return { error: usersResult.error.message };
    if (profilesResult.error) return { error: profilesResult.error.message };
    if (!usersResult.data?.length && !profilesResult.data?.length) {
      return { error: "Approval did not apply -- you may not be authorized, or the account was already reviewed." };
    }

    revalidatePath("/icms/admin/users");
    revalidatePath("/avsec/admin/users");
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to approve account" };
  }
}

export async function rejectStaff(_prev: ApprovalState, formData: FormData): Promise<ApprovalState> {
  try {
    await requireRole(["supervisor"]);
  } catch {
    return { error: "Not authorized to reject accounts." };
  }

  const userId = String(formData.get("user_id") ?? "").trim();
  if (!userId) return { error: "User ID is required." };

  try {
    const supabase = await createClient();
    const [usersResult, profilesResult] = await Promise.all([
      supabase.from("users").update({ status: "rejected" }).eq("id", userId).select("id"),
      supabase.from("profiles").update({ status: "rejected" as ProfileStatus }).eq("id", userId).select("id"),
    ]);

    if (usersResult.error) return { error: usersResult.error.message };
    if (profilesResult.error) return { error: profilesResult.error.message };
    if (!usersResult.data?.length && !profilesResult.data?.length) {
      return { error: "Rejection did not apply -- you may not be authorized, or the account was already reviewed." };
    }

    revalidatePath("/icms/admin/users");
    revalidatePath("/avsec/admin/users");
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to reject account" };
  }
}
