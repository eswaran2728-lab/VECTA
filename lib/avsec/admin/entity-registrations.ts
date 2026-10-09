"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * MAA/AAX entity-admin registration path. The database is the authority: approve_registration_request() binds the approval to the
 * request's OWN entity and AOC, refuses protected roles, and validates the scope shape. This file adds no authorization logic and
 * never accepts an AOC or entity from the browser -- both come from the request itself, read back through the options RPC.
 */

export interface EntityRegistrationRequestRow {
  id: string;
  staffName: string;
  staffNo: string;
  requestedRoleCode: string | null;
  requestedHubCode: string | null;
  requestedStationCode: string | null;
  requestedTeamName: string | null;
  applicantNotes: string | null;
  submittedAt: string;
  operatingEntityCode: string;
  isTransfer: boolean;
}

export async function listEntityRegistrationRequests(): Promise<{ ok: boolean; rows: EntityRegistrationRequestRow[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_entity_registration_requests_detailed_secure");
  if (error) return { ok: false, rows: [], error: "The registration list could not be loaded." };
  return {
    ok: true,
    error: null,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      staffName: r.staff_name,
      staffNo: r.staff_no,
      requestedRoleCode: r.requested_role_code,
      requestedHubCode: r.requested_hub_code,
      requestedStationCode: r.requested_station_code,
      requestedTeamName: r.requested_team_name,
      applicantNotes: r.applicant_notes,
      submittedAt: r.submitted_at,
      operatingEntityCode: r.operating_entity_code,
      isTransfer: r.is_transfer,
    })),
  };
}

export interface RegistrationOptions {
  request: {
    id: string;
    entity_code: string;
    entity_id: string;
    aoc_id: string;
    aoc_code: string | null;
    requested_role_code: string | null;
    requested_department_id: string | null;
    requested_unit_id: string | null;
    requested_hub_id: string | null;
    requested_station_id: string | null;
    requested_team_id: string | null;
  };
  roles: Array<{ code: string; name: string; category: string }>;
  departments: Array<{ id: string; code: string; name: string }>;
  units: Array<{ id: string; department_id: string; code: string; name: string }>;
  hubs: Array<{ id: string; code: string; name: string }>;
  stations: Array<{ id: string; hub_id: string; code: string; name: string }>;
  teams: Array<{ id: string; station_id: string; name: string }>;
}

export async function getRegistrationAssignmentOptions(requestId: string): Promise<{ ok: boolean; options: RegistrationOptions | null; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_registration_assignment_options_secure", { p_request_id: requestId });
  if (error || !data) return { ok: false, options: null, error: "This request is not available to you." };
  return { ok: true, options: data as unknown as RegistrationOptions, error: null };
}

export interface EntityApprovalResult {
  ok: boolean;
  error: string | null;
}

function pick(formData: FormData, name: string): string | null {
  const v = String(formData.get(name) ?? "").trim();
  return v === "" ? null : v;
}

export async function approveEntityRegistration(formData: FormData): Promise<EntityApprovalResult> {
  const supabase = await createClient();
  const requestId = pick(formData, "requestId");
  const roleCode = pick(formData, "roleCode");
  if (!requestId || !roleCode) return { ok: false, error: "A request and a role are required." };

  // AOC and entity are read back from the request itself (the caller must administer that entity), never from the form.
  const { data: raw, error: optionsError } = await supabase.rpc("list_registration_assignment_options_secure", { p_request_id: requestId });
  if (optionsError || !raw) return { ok: false, error: "This request is not available to you." };
  const request = (raw as { request?: { aoc_id?: string; entity_id?: string } }).request;
  if (!request?.aoc_id || !request.entity_id) return { ok: false, error: "This request is not available to you." };

  const { error } = await supabase.rpc("approve_registration_request", {
    p_request_id: requestId,
    p_role_code: roleCode,
    p_aoc_id: request.aoc_id,
    p_operating_entity_id: request.entity_id,
    p_department_id: pick(formData, "departmentId"),
    p_unit_id: pick(formData, "unitId"),
    p_hub_id: pick(formData, "hubId"),
    p_station_id: pick(formData, "stationId"),
    p_team_id: pick(formData, "teamId"),
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/avsec/admin/entity-registrations");
  return { ok: true, error: null };
}

export async function rejectEntityRegistration(formData: FormData): Promise<EntityApprovalResult> {
  const supabase = await createClient();
  const requestId = pick(formData, "requestId");
  const reason = String(formData.get("reason") || "").trim();
  if (!requestId || !reason) return { ok: false, error: "A request and a rejection reason are both required." };

  const { error } = await supabase.rpc("reject_registration_request", { p_request_id: requestId, p_reason: reason });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/avsec/admin/entity-registrations");
  return { ok: true, error: null };
}

/** Own-entity directory export (the RPC re-checks the caller administers this entity, audits the export and omits protected roles). */
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
  return { ok: true, error: null, data: (data ?? []) as unknown as EntityDirectoryRow[] };
}

