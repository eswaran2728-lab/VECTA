import { createClient } from "@/lib/supabase/server";
import { getShiftCompliance } from "@/lib/avsec/dashboard/queries";
import { todayISODateMY } from "@/lib/avsec/datetime";

export interface UnfinishedWorkItem {
  category: "Catering Movement" | "Incident" | "SEC 014 Report";
  summary: string;
  responsibleOfficer: string;
  nextAction: string;
}

/**
 * Snapshot of unfinished work for a station (+ team, for the report-filing
 * check) at the moment a handover is created. Stored on the handover row so
 * the record reflects what was actually outstanding at handover time, not
 * whatever the live counts happen to be when someone reads it back later.
 */
export async function getUnfinishedWorkSummary(station: string, team?: string): Promise<UnfinishedWorkItem[]> {
  const supabase = await createClient();
  const items: UnfinishedWorkItem[] = [];

  const [{ data: transactions }, { data: incidents }, compliance] = await Promise.all([
    supabase
      .from("transactions")
      .select("transaction_number, status, driver_name, escort_officer_name")
      .eq("archived", false)
      .eq("station", station)
      .in("status", ["CREATED", "INFLIGHT_POST_APPROVED", "AIRPORT_POST_APPROVED"]),
    supabase
      .from("incidents")
      .select("id, incident_type, status, transactions!inner(transaction_number, station, archived)")
      .eq("transactions.station", station)
      .eq("transactions.archived", false)
      .in("status", ["OPEN", "UNDER_REVIEW"]),
    getShiftCompliance(station, todayISODateMY(), team),
  ]);

  for (const t of transactions ?? []) {
    items.push({
      category: "Catering Movement",
      summary: `${t.transaction_number} — ${t.status.replaceAll("_", " ")}`,
      responsibleOfficer: t.driver_name || t.escort_officer_name || "Unassigned",
      nextAction: "Awaiting next checkpoint clearance",
    });
  }

  for (const i of (incidents ?? []) as unknown as {
    id: string;
    incident_type: string;
    status: string;
    transactions: { transaction_number: string } | null;
  }[]) {
    items.push({
      category: "Incident",
      summary: `${i.incident_type} — ${i.transactions?.transaction_number ?? "—"}`,
      responsibleOfficer: "Supervisor/Enforcement on duty",
      nextAction: i.status === "OPEN" ? "Needs review" : "Under review — needs resolution",
    });
  }

  for (const c of compliance) {
    if (c.submitted) continue;
    items.push({
      category: "SEC 014 Report",
      summary: `Daily patrol report not yet filed`,
      responsibleOfficer: c.profile.name,
      nextAction: "File SEC 014 before shift ends",
    });
  }

  return items;
}

export interface ShiftHandoverRow {
  id: string;
  outgoing_profile_id: string;
  station: string;
  team: string | null;
  staff_name: string;
  staff_id: string;
  place_category: "Bay" | "Premises" | "Terminal";
  place_detail: string;
  flight_number: string | null;
  handover_notes: string;
  unfinished_work_summary: UnfinishedWorkItem[];
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledgment_notes: string | null;
  created_at: string;
}

/** RLS scopes this to the caller's own handovers, their station+team, or
 * org-wide roles — same visibility shape as overtime_requests. */
export async function getVisibleHandovers(): Promise<ShiftHandoverRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("shift_handovers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  return (data as unknown as ShiftHandoverRow[]) ?? [];
}
