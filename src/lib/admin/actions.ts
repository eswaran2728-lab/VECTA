"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { REQUESTABLE_ROLES, ORG_WIDE_ROLES, type UserRole } from "@/lib/reference-data";

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
    redirect("/admin/users?error=" + encodeURIComponent("Fill in name, email, role, station and a password of at least 6 characters."));
  }
  if (!isOrgWide && (!staffNo || !team)) {
    redirect("/admin/users?error=" + encodeURIComponent("Staff ID and Team are required for this role."));
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
    redirect("/admin/users?error=" + encodeURIComponent(`createUser threw: ${message}`));
  }

  if (createUserResult.error || !createUserResult.data.user) {
    redirect("/admin/users?error=" + encodeURIComponent(createUserResult.error?.message || "Could not create account."));
  }
  const data = createUserResult.data;

  const supabase = createClient();
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
    redirect("/admin/users?error=" + encodeURIComponent(profileError.message));
  }

  revalidatePath("/admin/users");
}

export async function approveUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = createClient();
  await supabase.from("profiles").update({ status: "approved" }).eq("id", profileId);
  revalidatePath("/admin/users");
}

export async function rejectUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = createClient();
  await supabase.from("profiles").update({ status: "rejected" }).eq("id", profileId);
  revalidatePath("/admin/users");
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

  const supabase = createClient();
  await supabase
    .from("profiles")
    .update({ station, team: isOrgWide ? "" : team, role })
    .eq("id", profileId);
  revalidatePath("/admin/users");
}
