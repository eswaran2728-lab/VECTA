"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/icms/auth";
import type { ProfileStatus } from "@/lib/avsec/reference-data";

export interface ApprovalState {
  error: string | null;
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
