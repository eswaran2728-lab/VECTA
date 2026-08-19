import { createClient } from "@/lib/avsec/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { DashboardFilters } from "@/lib/avsec/dashboard/queries";

function rangeToTimestamps(filters: DashboardFilters) {
  const from = `${filters.dateFrom}T00:00:00+08:00`;
  const to = `${filters.dateTo}T23:59:59.999+08:00`;
  return { from, to };
}

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
    offload: [],
  };

  await Promise.all(
    types.map(async (type) => {
      let query = supabase
        .from(REPORT_META[type].table)
        .select("*")
        .eq("status", "submitted")
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
