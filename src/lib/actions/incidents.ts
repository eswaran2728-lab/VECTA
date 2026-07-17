"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { IncidentStatus } from "@/lib/database.types";

export interface ResolveState {
  error: string | null;
  success: string | null;
}

const ORDER: IncidentStatus[] = ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"];

/**
 * Admin moves an incident forward through its lifecycle.
 * Notes are mandatory from RESOLVED onward; the DB trigger enforces the
 * same rules again (forward-only, facts immutable).
 */
export async function resolveIncident(
  _prev: ResolveState,
  formData: FormData
): Promise<ResolveState> {
  const admin = await requireRole(["supervisor"]);

  const incidentId = String(formData.get("incident_id") ?? "");
  const nextStatus = String(formData.get("status") ?? "") as IncidentStatus;
  const notes = String(formData.get("resolution_notes") ?? "").trim();

  if (!incidentId || !ORDER.includes(nextStatus)) {
    return { error: "Invalid resolution request.", success: null };
  }
  if (ORDER.indexOf(nextStatus) >= 2 && !notes) {
    return { error: "Resolution notes are mandatory to resolve or close.", success: null };
  }

  const supabase = await createClient();
  const { data: incident } = await supabase
    .from("incidents")
    .select("status")
    .eq("id", incidentId)
    .single();
  if (!incident) return { error: "Incident not found.", success: null };

  if (ORDER.indexOf(nextStatus) <= ORDER.indexOf(incident.status as IncidentStatus)) {
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

  revalidatePath("/incidents");
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
