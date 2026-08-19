"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Self-registration (registerStaff / app/(icms)/icms/register) has been
// removed — accounts are admin/management-created only, via the Admin
// panel (see app/(icms)/icms/admin/users and
// components/avsec/admin/CreateAccountForm.tsx). Full SSO via AirAsia's
// Google Workspace domain is planned as a future replacement for Supabase
// email/password auth, but that's a later migration — approveStaff/
// rejectStaff below are kept only to resolve any pre-existing 'pending'
// rows from before self-registration was removed.

export interface ApprovalState {
  error: string | null;
}

/** Admin approves a pending registration — flips status to active. */
export async function approveStaff(
  _prev: ApprovalState,
  formData: FormData
): Promise<ApprovalState> {
  await requireRole(["supervisor"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing account reference." };

  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ status: "active" }).eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath("/icms/admin/users");
  return { error: null };
}

/**
 * Admin rejects a pending registration. The account is kept for history
 * (never deleted) and stays permanently blocked from sign-in.
 */
export async function rejectStaff(
  _prev: ApprovalState,
  formData: FormData
): Promise<ApprovalState> {
  await requireRole(["supervisor"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!userId) return { error: "Missing account reference." };

  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ status: "rejected" }).eq("id", userId);
  if (error) return { error: error.message };

  revalidatePath("/icms/admin/users");
  return { error: null };
}
