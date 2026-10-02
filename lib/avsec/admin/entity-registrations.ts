"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * MAA/AAX entity-admin registration path (Phase 13 correction).
 *
 * The underlying RPCs (approve_registration_request,
 * reject_registration_request) ALREADY correctly authorize a
 * maa_admin/aax_admin caller via is_entity_admin() -- confirmed during
 * this phase's audit, and unchanged here. What was missing was any
 * application code calling them: this file is the first caller.
 * list_entity_registration_requests_secure() (new this phase) scopes the
 * listing itself to exactly the entity/entities the caller administers,
 * so a MAA Admin never even sees an AAX-requested registration.
 */

export interface EntityRegistrationRequestRow {
  id: string;
  profile_id: string;
  requested_role_code: string | null;
  status: string;
  submitted_at: string;
  operating_entity_code: string;
}

export async function listEntityRegistrationRequests(): Promise<EntityRegistrationRequestRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_entity_registration_requests_secure");
  if (error) {
    console.error("Error listing entity registration requests:", error.message);
    return [];
  }
  return data ?? [];
}

export interface EntityApprovalResult {
  ok: boolean;
  error: string | null;
}

export async function approveEntityRegistration(formData: FormData): Promise<EntityApprovalResult> {
  const supabase = await createClient();
  const requestId = String(formData.get("requestId") || "");
  const roleCode = String(formData.get("roleCode") || "");
  const aocId = String(formData.get("aocId") || "");
  const operatingEntityCode = String(formData.get("operatingEntityCode") || "");
  const departmentId = (formData.get("departmentId") as string) || null;
  const unitId = (formData.get("unitId") as string) || null;
  const hubId = (formData.get("hubId") as string) || null;
  const stationId = (formData.get("stationId") as string) || null;
  const teamId = (formData.get("teamId") as string) || null;
  const opsGroup = (formData.get("opsGroup") as string) || null;

  if (!requestId || !roleCode || !aocId || !operatingEntityCode) {
    return { ok: false, error: "Request, role, AOC, and operating entity are all required." };
  }

  // The RPC takes an entity id, not a code -- resolved here rather than
  // trusting a client-supplied id, since a mismatched id/code pair could
  // otherwise let the UI claim one entity while actually targeting
  // another. is_entity_admin() inside approve_registration_request is
  // still the real authorization check either way. operating_entities
  // itself has zero grant to `authenticated`, so this goes through the
  // dedicated read-only resolver RPC rather than a direct table select.
  const { data: entityId, error: entityError } = await supabase.rpc("resolve_operating_entity_id_secure", {
    p_code: operatingEntityCode,
  });
  if (entityError || !entityId) {
    return { ok: false, error: "Unknown operating entity." };
  }

  // Authorization (is_entity_admin, cross-entity/cross-AOC denial, protected-role
  // exclusion) is enforced entirely inside approve_registration_request --
  // this action adds no authorization logic of its own, by design.
  const { error } = await supabase.rpc("approve_registration_request", {
    p_request_id: requestId,
    p_role_code: roleCode,
    p_aoc_id: aocId,
    p_operating_entity_id: entityId,
    p_department_id: departmentId,
    p_unit_id: unitId,
    p_hub_id: hubId,
    p_station_id: stationId,
    p_team_id: teamId,
    p_ops_group: opsGroup,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/avsec/admin/entity-registrations");
  return { ok: true, error: null };
}

/**
 * Phase 13 correction: export_entity_user_directory() existed in the
 * database with zero application callers (same confirmed-orphaned
 * pattern as export_caterlink_data_secure -- see
 * docs/phase13/export-audit-inventory.md). This is the first caller, for
 * MAA/AAX Admin's confirmed "assigned-entity user-directory exports"
 * ownership. Authorization (is_entity_admin for the requested code) is
 * enforced entirely inside the RPC.
 */
export interface EntityDirectoryRow {
  profile_id: string;
  name: string;
  staff_no: string;
  role_code: string;
  [key: string]: unknown;
}

export async function exportEntityUserDirectory(entityCode: string): Promise<{ ok: boolean; error: string | null; data: EntityDirectoryRow[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_entity_user_directory", { p_entity_code: entityCode });
  if (error) return { ok: false, error: error.message, data: [] };
  return { ok: true, error: null, data: data ?? [] };
}

export async function rejectEntityRegistration(formData: FormData): Promise<EntityApprovalResult> {
  const supabase = await createClient();
  const requestId = String(formData.get("requestId") || "");
  const reason = String(formData.get("reason") || "").trim();

  if (!requestId || !reason) {
    return { ok: false, error: "A request id and reason are both required." };
  }

  const { error } = await supabase.rpc("reject_registration_request", {
    p_request_id: requestId,
    p_reason: reason,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath("/avsec/admin/entity-registrations");
  return { ok: true, error: null };
}
