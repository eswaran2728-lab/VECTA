"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { isProfileActiveSuperAdmin } from "@/lib/super-admin/authority";
import {
  REQUESTABLE_ROLES,
  ORG_WIDE_ROLES,
  type UserRole,
} from "@/lib/avsec/reference-data";
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
  const password = String(formData.get("password") || "");

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);

  if (!name || !email || !allRoles.includes(role) || !station || password.length < 6) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Fill in name, email, role, station and a password of at least 6 characters."));
  }
  if (!isOrgWide && (!staffNo || !team)) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Staff ID and Team are required for this role."));
  }

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

  const supabase = await createClient();
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      name,
      staff_no: isOrgWide ? "" : staffNo,
      station,
      team: isOrgWide ? "" : team,
      role: safeRole as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
      status: "approved",
    })
    .eq("id", data.user!.id);

  if (profileError) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(profileError.message));
  }

  // No ICMS identity row is created: ICMS/CaterLink access is decided from the
  // account's canonical role assignments (granted through the registration
  // approval workflow), not from a second legacy identity record.

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
  if (!profileId) return;

  // Defense in depth: RLS/the trigger already forbid a self-target write,
  // but fail fast here too rather than rely on that alone.
  if (profileId === manager.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot approve your own account."));
  }

  const validation = validateApprovalAssignment({ role, station, team });
  if (!validation.ok) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(validation.error));
  }

  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);

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
  if (await isProfileActiveSuperAdmin(profileId)) {
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
  if (await isProfileActiveSuperAdmin(profileId)) {
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
  if (!profileId || !station || !role) return;

  const supabase = await createClient();
  if (await isProfileActiveSuperAdmin(profileId)) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("Cannot reassign a Super Admin account."));
  }

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  if (!allRoles.includes(role)) return;
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);
  const safeRole = role === "ADMIN" ? "MANAGEMENT" : role;

  const { data, error } = await supabase
    .from("profiles")
    .update({
      station,
      team: isOrgWide ? "" : team,
      role: safeRole as "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT",
    })
    .eq("id", profileId)
    .select("id");

  // Previously unchecked: a rejected write (RLS/trigger denial -- e.g. the
  // super_admin/management containment migration blocking unified_role, or
  // any other future policy tightening) silently reported success to the
  // caller with no row actually changed. Surface it the same way every
  // other admin action on this page already does.
  if (error) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(error.message));
  }
  if (!data || data.length === 0) {
    redirect(
      "/avsec/admin/users?error=" +
        encodeURIComponent("Reassignment did not apply — you may not be authorized to modify this account, or the change was rejected."),
    );
  }

  revalidatePath("/avsec/admin/users");
  redirect("/avsec/admin/users?success=" + encodeURIComponent("Assignment updated."));
}
