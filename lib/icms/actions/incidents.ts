"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { INCIDENT_LIFECYCLE, lifecycleFor } from "@/lib/icms/constants";
import type { IncidentStatus, IncidentType } from "@/lib/icms/database.types";

export interface ResolveState {
  error: string | null;
  success: string | null;
}

const ORDER = INCIDENT_LIFECYCLE;

/**
 * Admin moves an incident forward through its lifecycle.
 * Notes are mandatory from RESOLVED onward; the DB trigger enforces the
 * same rules again (forward-only, facts immutable, lifecycle keyed off type).
 */
export async function resolveIncident(
  _prev: ResolveState,
  formData: FormData
): Promise<ResolveState> {
  const admin = await requireRole(["supervisor", "enforcement", "management"]);

  const incidentId = String(formData.get("incident_id") ?? "");
  const nextStatus = String(formData.get("status") ?? "") as IncidentStatus;
  const notes = String(formData.get("resolution_notes") ?? "").trim();

  if (!incidentId || !ORDER.includes(nextStatus)) {
    return { error: "Invalid resolution request.", success: null };
  }

  const supabase = await createClient();
  const { data: incident } = await supabase
    .from("incidents")
    .select("status, incident_type")
    .eq("id", incidentId)
    .single();
  if (!incident) return { error: "Incident not found.", success: null };

  const order = lifecycleFor(incident.incident_type as IncidentType);
  if (!order.includes(nextStatus)) {
    return {
      error: `${incident.incident_type} incidents only move through ${order.join(" -> ")}.`,
      success: null,
    };
  }
  if (nextStatus === "RESOLVED" || nextStatus === "CLOSED") {
    if (!notes) return { error: "Resolution notes are mandatory to resolve or close.", success: null };
  }
  if (order.indexOf(nextStatus) <= order.indexOf(incident.status as IncidentStatus)) {
    return {
      error: `Status can only move forward (currently ${incident.status}).`,
      success: null,
    };
  }

  const { error } = await supabase
    .from("incidents")
    .update({
      status: nextStatus,
      resolution_notes: notes || null,
      resolved_by: ORDER.indexOf(nextStatus) >= 2 ? admin.id : null,
      resolved_at: ORDER.indexOf(nextStatus) >= 2 ? new Date().toISOString() : null,
    })
    .eq("id", incidentId);

  if (error) return { error: error.message, success: null };

  revalidatePath("/icms/incidents");
  return { error: null, success: `Incident moved to ${nextStatus}.` };
}

/** Mark all of the current user's notifications as read. */
export async function markNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id);
}
