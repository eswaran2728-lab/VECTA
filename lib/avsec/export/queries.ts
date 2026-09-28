import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { DashboardFilters } from "@/lib/avsec/dashboard/queries";

function rangeToTimestamps(filters: DashboardFilters) {
  const from = `${filters.dateFrom}T00:00:00+08:00`;
  const to = `${filters.dateTo}T23:59:59.999+08:00`;
  return { from, to };
}

/** Secure two-step pattern (see lib/avsec/dashboard/queries.ts): list_reports_secure()
 * authorizes each report via has_report_access() before this function ever reads a
 * source table; the read below is scoped to exactly that authorized id set. A single
 * 'export_generated' audit row (via export_reports_secure(), not one row per exported
 * report) is written for the export as a whole. Returns empty per type until reports
 * are indexed into the repository -- expected fail-closed behavior until the Phase 5/6
 * rollout runs for this environment. */
export async function getFullRowsForExport(
  filters: DashboardFilters,
): Promise<Record<ReportType, Record<string, unknown>[]>> {
  const supabase = await createClient();
  const { from, to } = rangeToTimestamps(filters);
  const types: ReportType[] = filters.reportType ? [filters.reportType] : [...REPORT_TYPES];

  const out: Record<ReportType, Record<string, unknown>[]> = {
    sec016: [],
    sec014: [],
    sec029: [],
    sec018: [],
    sec033: [],
    sec013: [],
  };

  // One audit row for this export as a whole -- authorization for each
  // included row is still individually enforced per-type below via the
  // authorized id set, this call only records that an export happened.
  await supabase.rpc("export_reports_secure", {
    p_max_rows: 1,
    p_from_date: filters.dateFrom,
    p_to_date: filters.dateTo,
    p_station_id: null,
  });

  await Promise.all(
    types.map(async (type) => {
      const table = REPORT_META[type].table;
      const { data: authorized } = await supabase.rpc("list_reports_secure", {
        p_page: 1,
        p_page_size: 100,
        p_source_table: table,
        p_from_date: filters.dateFrom,
        p_to_date: filters.dateTo,
      });
      const ids = (authorized ?? []).map((r) => r.id);
      if (ids.length === 0) return;

      let query = supabase
        .from(table as never)
        .select("*")
        .eq("status", "submitted")
        .in("id", ids)
        .gte("submitted_at", from)
        .lte("submitted_at", to);
      if (filters.station) query = query.eq("station", filters.station);
      if (filters.team) query = query.eq("team", filters.team);
      if (filters.officerId) query = query.eq("profile_id", filters.officerId);

      const { data } = await query.order("submitted_at", { ascending: false });
      out[type] = (data as Record<string, unknown>[]) ?? [];
    }),
  );

  return out;
}
