"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import {
  REQUESTABLE_ROLES,
  ORG_WIDE_ROLES,
  OPS_GROUPS,
  OPS_GROUP_REQUIRED_ROLES,
  type UserRole,
  type OpsGroup,
} from "@/lib/avsec/reference-data";
import { buildShadowUserRow } from "@/lib/icms/shadow-user";
import { validateApprovalAssignment } from "@/lib/avsec/admin/validation";

export async function createStaffAccount(formData: FormData) {
  await requireRole(MANAGEMENT_ROLES);

  const name = String(formData.get("name") || "").trim();
  const staffNo = String(formData.get("staffNo") || "").trim();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const role = String(formData.get("role") || "").trim() as UserRole;
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const opsGroupInput = String(formData.get("opsGroup") || "").trim() as OpsGroup | "";
  const password = String(formData.get("password") || "");

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const needsOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(role);

  if (!name || !email || !allRoles.includes(role) || !station || password.length < 6) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Fill in name, email, role, station and a password of at least 6 characters."));
  }
  if (!isOrgWide && (!staffNo || !team)) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Staff ID and Team are required for this role."));
  }
  if (needsOpsGroup && !(OPS_GROUPS as readonly string[]).includes(opsGroupInput)) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Select an ops group for this role (Operation AVSEC / IFC AVSEC / Hub AVSEC)."));
  }
  // ORG_WIDE_ROLES (see across all 3 groups) never carry an ops_group.
  const opsGroup: OpsGroup | null = needsOpsGroup ? (opsGroupInput as OpsGroup) : null;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent(
          `Missing server config — SUPABASE_URL: ${supabaseUrl ? "present (" + supabaseUrl.length + " chars)" : "MISSING"}, SUPABASE_SERVICE_ROLE_KEY: ${serviceRoleKey ? "present (" + serviceRoleKey.length + " chars)" : "MISSING"}.`,
        ),
    );
  }

  let createUserResult: Awaited<ReturnType<ReturnType<typeof createAdminClient>["auth"]["admin"]["createUser"]>>;
  try {
    const admin = createAdminClient();
    createUserResult = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error creating account.";
    redirect("/avsec/admin/users?error=" + encodeURIComponent(`createUser threw: ${message}`));
  }

  if (createUserResult.error || !createUserResult.data.user) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(createUserResult.error?.message || "Could not create account."));
  }
  const data = createUserResult.data;

  const safeRole = role === "ADMIN" ? "MANAGEMENT" : role;
  const unifiedRole =
    safeRole === "MANAGEMENT"
      ? "management"
      : safeRole === "ENFORCEMENT"
        ? "enforcement"
        : safeRole === "DSE"
          ? "dse"
          : safeRole === "SO"
            ? "so"
            : "aso";

  const supabase = await createClient();
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      name,
      staff_no: isOrgWide ? "" : staffNo,
      station,
      team: isOrgWide ? "" : team,
      role: safeRole as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
      unified_role: unifiedRole,
      ops_group: opsGroup,
      status: "approved",
    })
    .eq("id", data.user!.id);

  if (profileError) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(profileError.message));
  }

  const { error: shadowUserError } = await createAdminClient()
    .from("users")
    .insert(
      buildShadowUserRow({
        id: data.user!.id,
        name,
        email,
        role,
        staff_no: isOrgWide ? null : staffNo,
        ops_group: opsGroup,
      })
    );

  if (shadowUserError) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent(`Account created, but its ICMS identity could not be provisioned: ${shadowUserError.message}`),
    );
  }

  revalidatePath("/avsec/admin/users");
}

/**
 * Reactivates an already-reviewed (e.g. deactivated) user — status-only,
 * no field reassignment. NOT used for the initial pending-registration
 * approval flow (see approveUserWithAssignment below), which requires
 * Management to explicitly (re-)select every field.
 */
export async function approveUser(formData: FormData) {
  const manager = await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;
  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot reactivate your own account."));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update({ status: "approved" }).eq("id", profileId).select("id");
  if (error) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(error.message));
  }
  if (!data || data.length === 0) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent("Reactivation did not apply — you may not be authorized, or the account is still pending initial review."),
    );
  }
  revalidatePath("/avsec/admin/users");
  redirect("/avsec/admin/users?success=" + encodeURIComponent("Account reactivated."));
}

export async function approveUserWithAssignment(formData: FormData) {
  const manager = await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  const role = String(formData.get("role") || "").trim();
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const opsGroupInput = String(formData.get("opsGroup") || "").trim();
  if (!profileId) return;

  // Defense in depth: RLS/the trigger already forbid a self-target write,
  // but fail fast here too rather than rely on that alone.
  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot approve your own account."));
  }

  const validation = validateApprovalAssignment({ role, station, team, opsGroup: opsGroupInput });
  if (!validation.ok) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(validation.error));
  }

  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const needsOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(role);
  const opsGroup: OpsGroup | null = needsOpsGroup ? (opsGroupInput as OpsGroup) : null;

  const supabase = await createClient();
  // Atomic: one UPDATE statement sets every final assignment, the
  // approval status, and the approver/timestamp together — there is no
  // intermediate state where status is "approved" but the assignment is
  // still incomplete, because it's all in this single write or none of it
  // is (RLS/the trigger reject the whole statement if anything about it
  // is invalid, e.g. role='ADMIN' or a self-target).
  const { data, error } = await supabase
    .from("profiles")
    .update({
      role: role as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
      station,
      team: isOrgWide ? "" : team,
      ops_group: opsGroup,
      status: "approved",
      approved_by: manager.id,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq("id", profileId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(error.message));
  }
  if (!data || data.length === 0) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent("Approval did not apply — you may not be authorized to approve this account, or it was already reviewed."),
    );
  }

  // Keep the ICMS shadow row in sync so the newly-approved account can
  // actually use CaterLink/ICMS features immediately, same mapping
  // createStaffAccount() uses.
  const { mapAvsecRoleToIcmsRole, mapAvsecRoleToUnifiedRole } = await import("@/lib/icms/shadow-user");
  await createAdminClient()
    .from("users")
    .update({
      role: mapAvsecRoleToIcmsRole(role),
      unified_role: mapAvsecRoleToUnifiedRole(role),
      ops_group: opsGroup,
      status: "active",
    })
    .eq("id", profileId);

  revalidatePath("/avsec/admin/users");
  redirect("/avsec/admin/users?success=" + encodeURIComponent("Account approved."));
}

export async function rejectUser(formData: FormData) {
  const manager = await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  const reason = String(formData.get("reason") || "").trim();
  if (!profileId) return;

  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot reject your own account."));
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ status: "rejected", rejection_reason: reason || null, approved_by: manager.id, approved_at: new Date().toISOString() })
    .eq("id", profileId)
    .select("id");
  if (error) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(error.message));
  }
  if (!data || data.length === 0) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent("Rejection did not apply — you may not be authorized to reject this account, or it was already reviewed."),
    );
  }
  revalidatePath("/avsec/admin/users");
  redirect("/avsec/admin/users?success=" + encodeURIComponent("Account rejected."));
}

export async function deactivateUser(formData: FormData) {
  const manager = await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot deactivate your own account."));
  }

  const supabase = await createClient();
  const { data: target } = await supabase.from("profiles").select("role, unified_role").eq("id", profileId).maybeSingle();
  if ((target?.role as string) === "SUPER_ADMIN" || target?.unified_role === "super_admin") {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Cannot deactivate a Super Admin account."));
  }

  await supabase.from("profiles").update({ status: "deactivated" }).eq("id", profileId);
  revalidatePath("/avsec/admin/users");
}

const REPORT_TABLES = [
  "report_sec016",
  "report_sec014",
  "report_sec029",
  "report_sec018",
  "report_sec033",
  "report_sec013",
] as const;

export async function deleteUserAccount(formData: FormData) {
  const manager = await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot delete your own account."));
  }

  const supabase = await createClient();
  const { data: target } = await supabase.from("profiles").select("role, unified_role").eq("id", profileId).maybeSingle();
  if ((target?.role as string) === "SUPER_ADMIN" || target?.unified_role === "super_admin") {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Cannot delete a Super Admin account."));
  }

  const [reportCounts, ackCount, bayBoardCount] = await Promise.all([
    Promise.all(
      REPORT_TABLES.map((table) => supabase.from(table).select("id", { count: "exact", head: true }).eq("profile_id", profileId)),
    ),
    supabase.from("report_acknowledgements").select("id", { count: "exact", head: true }).eq("acknowledged_by", profileId),
    supabase.from("bay_board").select("id", { count: "exact", head: true }).eq("created_by", profileId),
  ]);
  const totalReports = reportCounts.reduce((sum, r) => sum + (r.count ?? 0), 0);
  const totalOther = (ackCount.count ?? 0) + (bayBoardCount.count ?? 0);
  if (totalReports > 0 || totalOther > 0) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent(
          `Can't delete — this account has ${totalReports} submitted report(s) and ${totalOther} other linked record(s) (acknowledgements/bay board entries). Use Deactivate instead to keep their records intact.`,
        ),
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."));
  }

  try {
    const adminClient = createAdminClient();
    const { error } = await adminClient.auth.admin.deleteUser(profileId);
    if (error) {
      redirect("/avsec/admin/users?error=" + encodeURIComponent(error.message));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error deleting account.";
    redirect("/avsec/admin/users?error=" + encodeURIComponent(`deleteUser threw: ${message}`));
  }

  revalidatePath("/avsec/admin/users");
}

export async function updateUserAssignment(formData: FormData) {
  await requireRole(MANAGEMENT_ROLES);
  const profileId = String(formData.get("profileId") || "");
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const role = String(formData.get("role") || "").trim() as UserRole;
  const opsGroupInput = String(formData.get("opsGroup") || "").trim() as OpsGroup | "";
  if (!profileId || !station || !role) return;

  const supabase = await createClient();
  const { data: target } = await supabase.from("profiles").select("role, unified_role").eq("id", profileId).maybeSingle();
  if ((target?.role as string) === "SUPER_ADMIN" || target?.unified_role === "super_admin") {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Cannot reassign a Super Admin account."));
  }

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  if (!allRoles.includes(role)) return;
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const needsOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(role);
  const opsGroup: OpsGroup | null =
    needsOpsGroup && (OPS_GROUPS as readonly string[]).includes(opsGroupInput) ? (opsGroupInput as OpsGroup) : null;

  const safeRole = role === "ADMIN" ? "MANAGEMENT" : role;
  const unifiedRole =
    safeRole === "MANAGEMENT"
      ? "management"
      : safeRole === "ENFORCEMENT"
        ? "enforcement"
        : safeRole === "DSE"
          ? "dse"
          : safeRole === "SO"
            ? "so"
            : "aso";

  await supabase
    .from("profiles")
    .update({
      station,
      team: isOrgWide ? "" : team,
      role: safeRole as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
      unified_role: unifiedRole,
      ops_group: opsGroup,
    })
    .eq("id", profileId);

  // Sync to ICMS shadow users table if exists
  await createAdminClient()
    .from("users")
    .update({
      unified_role: unifiedRole,
      ops_group: opsGroup,
    })
    .eq("id", profileId);

  revalidatePath("/avsec/admin/users");
}
