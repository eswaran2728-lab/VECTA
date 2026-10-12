"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * MAA/AAX Admin staff maintenance for their OWN entity: list, deactivate, same-entity reassignment, cross-entity transfer request.
 * The RPCs are the authority (own-entity admin only, protected roles refused, no self-service change, scope trigger validates the shape);
 * this file adds none. No assignment id is ever trusted from the browser without the database re-checking the admin's authority over it.
 */
export interface EntityStaffRow {
  assignmentId: string;
  staffNo: string;
  staffName: string;
  roleCode: string;
  departmentCode: string | null;
  unitCode: string | null;
  hubCode: string | null;
  stationCode: string | null;
  teamName: string | null;
  isSelf: boolean;
}

export async function listEntityStaff(search: string | null, page: number): Promise<{ ok: boolean; rows: EntityStaffRow[]; total: number; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_entity_staff_for_admin_secure", { p_search: search, p_page: page, p_page_size: 50 });
  if (error) return { ok: false, rows: [], total: 0, error: "The staff list could not be loaded." };
  return {
    ok: true,
    error: null,
    total: data && data.length > 0 ? Number(data[0].total_count) : 0,
    rows: (data ?? []).map((r) => ({
      assignmentId: r.assignment_id,
      staffNo: r.staff_no,
      staffName: r.staff_name,
      roleCode: r.role_code,
      departmentCode: r.department_code,
      unitCode: r.unit_code,
      hubCode: r.hub_code,
      stationCode: r.station_code,
      teamName: r.team_name,
      isSelf: r.is_self,
    })),
  };
}

export interface AssignmentOptions {
  entity_code: string;
  roles: Array<{ code: string; name: string; category: string }>;
  departments: Array<{ id: string; code: string; name: string }>;
  units: Array<{ id: string; department_id: string; code: string; name: string }>;
  hubs: Array<{ id: string; code: string; name: string }>;
  stations: Array<{ id: string; hub_id: string; code: string; name: string }>;
  teams: Array<{ id: string; station_id: string; name: string }>;
}

export async function getEntityAssignmentOptions(): Promise<{ ok: boolean; options: AssignmentOptions | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_entity_assignment_options_secure");
  if (error || !data) return { ok: false, options: null };
  return { ok: true, options: data as unknown as AssignmentOptions };
}

export interface StaffActionResult {
  ok: boolean;
  error: string | null;
}

function need(reason: string): string | null {
  return reason.trim().length >= 3 ? reason.trim() : null;
}

export async function deactivateEntityAssignment(assignmentId: string, reason: string): Promise<StaffActionResult> {
  const r = need(reason);
  if (!r) return { ok: false, error: "A reason is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("deactivate_assignment", { p_assignment_id: assignmentId, p_reason: r });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/admin/entity-staff");
  return { ok: true, error: null };
}

export async function reassignEntityAssignment(input: {
  assignmentId: string;
  roleCode: string;
  departmentId: string | null;
  unitId: string | null;
  hubId: string | null;
  stationId: string | null;
  teamId: string | null;
  reason: string;
}): Promise<StaffActionResult> {
  const r = need(input.reason);
  if (!r) return { ok: false, error: "A reason is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("transfer_assignment_same_entity", {
    p_old_assignment_id: input.assignmentId,
    p_new_role_code: input.roleCode,
    p_new_department_id: input.departmentId,
    p_new_unit_id: input.unitId,
    p_new_hub_id: input.hubId,
    p_new_station_id: input.stationId,
    p_new_team_id: input.teamId,
    p_reason: r,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/admin/entity-staff");
  return { ok: true, error: null };
}

/** Opens a registration request in the OTHER entity's queue; the person keeps their access until that entity's Admin approves. */
export async function requestCrossEntityTransfer(assignmentId: string, toEntityCode: "MAA" | "AAX", reason: string): Promise<StaffActionResult> {
  const r = need(reason);
  if (!r) return { ok: false, error: "A reason is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("initiate_cross_entity_transfer", { p_assignment_id: assignmentId, p_to_entity_code: toEntityCode, p_reason: r });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/admin/entity-staff");
  return { ok: true, error: null };
}
