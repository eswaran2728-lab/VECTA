import { createClient } from "@/lib/supabase/server";
import type { ReportType } from "@/lib/avsec/reference-data";

export interface FlightAttendanceRow {
  report_type: Extract<ReportType, "sec016" | "sec029" | "offload">;
  report_id: string;
  profile_id: string;
  flight_no: string;
  flight_date: string | null;
  station: string;
  team: string;
  staff_name: string;
  staff_id: string;
  aircraft_registration: string | null;
  location_detail: string | null;
  submitted_at: string | null;
}

export interface FlightAttendanceSearchResult {
  ok: boolean;
  results: FlightAttendanceRow[];
  error?: string;
}

/**
 * Enforcement Search — flight number (+ optional date) lookup across the only three report
 * types that actually carry a flight number (SEC016, SEC029, Offload). The DB-side RPC
 * enforces its own Enforcement/Management-only check and logs every call for audit — this
 * function is a thin, faithful wrapper, not a second place to duplicate that access rule.
 */
export async function searchFlightAttendance(flightNo: string, date?: string): Promise<FlightAttendanceSearchResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_flight_attendance", {
    p_flight_no: flightNo,
    p_date: date || undefined,
  });

  if (error) return { ok: false, results: [], error: error.message };
  return { ok: true, results: (data as FlightAttendanceRow[]) ?? [] };
}
