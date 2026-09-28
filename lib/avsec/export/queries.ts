import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { DashboardFilters } from "@/lib/avsec/dashboard/queries";

/** Atomic, single-call secure export: export_reports_secure() (Phase 6)
 * authorizes via has_report_access() AND returns the complete authorized
 * dataset (as `content` per row) in the SAME database call -- there is
 * no follow-up query against any report source table. Exactly one
 * 'export_generated' audit row is written per call (inside the RPC
 * itself), never one per exported report. Table names (report_sec016
 * etc.) are bucketed back into ReportType keys client-side from the
 * RPC's own `source_table` column; officerId narrows the already-
 * authorized, already-fetched rows further, it never widens them.
 * Returns empty until reports are indexed into the repository --
 * expected fail-closed behavior until the Phase 5/6 rollout runs. */
export async function getFullRowsForExport(
  filters: DashboardFilters,
): Promise<Record<ReportType, Record<string, unknown>[]>> {
  const supabase = await createClient();
  const types: ReportType[] = filters.reportType ? [filters.reportType] : [...REPORT_TYPES];
  const tableToType = new Map(types.map((t) => [REPORT_META[t].table, t]));

  const out: Record<ReportType, Record<string, unknown>[]> = {
    sec016: [],
    sec014: [],
    sec029: [],
    sec018: [],
    sec033: [],
    sec013: [],
  };

  const { data } = await supabase.rpc("export_reports_secure", {
    p_max_rows: 5000,
    p_from_date: filters.dateFrom,
    p_to_date: filters.dateTo,
    p_station_id: null,
    p_team_id: null,
  });

  for (const row of data ?? []) {
    const type = tableToType.get(row.source_table);
    if (!type || !row.content) continue;
    const content = row.content as Record<string, unknown>;
    if (content.status !== "submitted") continue;
    if (filters.station && content.station !== filters.station) continue;
    if (filters.team && content.team !== filters.team) continue;
    if (filters.officerId && content.profile_id !== filters.officerId) continue;
    out[type].push(content);
  }

  for (const type of types) {
    out[type].sort((a, b) => (((b.submitted_at as string) ?? "") < ((a.submitted_at as string) ?? "") ? -1 : 1));
  }

  return out;
}
