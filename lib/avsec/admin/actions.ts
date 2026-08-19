"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { REQUESTABLE_ROLES, ORG_WIDE_ROLES, type UserRole } from "@/lib/avsec/reference-data";

// Admin-created accounts skip the self-signup approval queue entirely (Admin vouches for
// them directly), and are created already email-confirmed since there's no signup flow
// for them to confirm through.
export async function createStaffAccount(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const name = String(formData.get("name") || "").trim();
  const staffNo = String(formData.get("staffNo") || "").trim();
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const role = String(formData.get("role") || "").trim() as UserRole;
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const password = String(formData.get("password") || "");

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "ADMIN"];
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
      "/admin/users?error=" +
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

  const supabase = await createClient();
  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      name,
      staff_no: isOrgWide ? "" : staffNo,
      station,
      team: isOrgWide ? "" : team,
      role,
      status: "approved",
    })
    .eq("id", data.user!.id);

  if (profileError) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent(profileError.message));
  }

  revalidatePath("/avsec/admin/users");
}

export async function approveUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = await createClient();
  await supabase.from("profiles").update({ status: "approved" }).eq("id", profileId);
  revalidatePath("/avsec/admin/users");
}

export async function rejectUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = await createClient();
  await supabase.from("profiles").update({ status: "rejected" }).eq("id", profileId);
  revalidatePath("/avsec/admin/users");
}

// For resigned/off-boarded staff: blocks their login immediately but keeps the account and
// all their historical report submissions intact for audit purposes. Reversible — Admin can
// reactivate (via approveUser) if it was a mistake or they return.
export async function deactivateUser(formData: FormData) {
  const admin = await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  if (profileId === admin.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot deactivate your own account."));
  }

  const supabase = await createClient();
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

// Permanently removes the account (Supabase Auth user + profile). Only allowed when the
// person has no report submissions at all — deleting a profile with report history would
// either fail outright (reports keep a required, non-cascading reference to it) or silently
// destroy official security records, neither of which is safe to do from a button click.
// Deactivate is the right call for anyone who has actually submitted reports.
export async function deleteUserAccount(formData: FormData) {
  const admin = await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  if (profileId === admin.id) {
    redirect("/avsec/admin/users?error=" + encodeURIComponent("You cannot delete your own account."));
  }

  const supabase = await createClient();
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
      "/admin/users?error=" +
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

// Lets Admin reassign someone's station/team mid-month (e.g. Kamal moves from Bravo to
// Alpha) or correct their role — including promoting to ADMIN, which users can never
// self-select.
export async function updateUserAssignment(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const role = String(formData.get("role") || "").trim() as UserRole;
  if (!profileId || !station || !role) return;

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "ADMIN"];
  if (!allRoles.includes(role)) return;
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);

  const supabase = await createClient();
  await supabase
    .from("profiles")
    .update({ station, team: isOrgWide ? "" : team, role })
    .eq("id", profileId);
  revalidatePath("/avsec/admin/users");
}
