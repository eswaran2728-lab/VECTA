"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSuperAdminRole } from "./authority";

export interface OrganizationRow {
  id: string;
  name: string;
  code: string | null;
  status: "active" | "inactive" | "suspended";
  created_by: string | null;
  created_at: string;
}

// Canonical authority only (active Phase 3 super_admin assignment) -- see
// lib/super-admin/authority.ts. Legacy profile/user role columns are never read.
export async function isSuperAdmin(): Promise<boolean> {
  return hasActiveSuperAdminRole();
}

export async function getOrganizations(): Promise<OrganizationRow[]> {
  const isSuper = await isSuperAdmin();
  if (!isSuper) return [];

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("organizations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching organizations:", error);
    return [];
  }
  return (data as OrganizationRow[]) ?? [];
}

export async function createOrganization(formData: FormData) {
  const isSuper = await isSuperAdmin();
  if (!isSuper) {
    return { error: "Unauthorized: Super Admin access required." };
  }

  const name = String(formData.get("name") || "").trim();
  const code = String(formData.get("code") || "").trim().toUpperCase();

  if (!name) {
    return { error: "Organization name is required." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("organizations")
    .insert({
      name,
      code: code || null,
      status: "active",
      created_by: user?.id ?? null,
    })
    .select()
    .single();

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/super-admin");
  return { success: true, organization: data as OrganizationRow };
}

export async function updateOrganizationStatus(orgId: string, status: "active" | "inactive" | "suspended") {
  const isSuper = await isSuperAdmin();
  if (!isSuper) {
    return { error: "Unauthorized: Super Admin access required." };
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("organizations")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", orgId);

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/super-admin");
  return { success: true };
}
