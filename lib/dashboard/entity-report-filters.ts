/**
 * Pure parsing of the entity report search query string. The database re-validates everything (search_reports_filtered_secure
 * rejects unknown types/statuses and inverted date ranges); this only keeps obviously malformed input out of the URL state and
 * keeps the logic unit-testable.
 */
export const REPORT_TYPE_OPTIONS = [
  { value: "report_sec016", label: "SEC016 Aircraft Attendance / Search" },
  { value: "report_sec029", label: "SEC029 Aircraft Search Checklist" },
  { value: "offload_records", label: "Offload Records" },
  { value: "report_sec014", label: "SEC014 Daily Report" },
  { value: "report_sec018", label: "SEC018 Patrol Report" },
  { value: "report_sec033", label: "SEC033 Report" },
  { value: "report_sec013", label: "SEC013 Profiling" },
] as const;

export const REPORT_STATUS_OPTIONS = [
  { value: "submitted", label: "Submitted" },
  { value: "amended", label: "Amended" },
  { value: "draft", label: "Draft" },
] as const;

/** Source table -> the /avsec/reports/view/[type]/[id] route segment. Offload records have no detail viewer (summary row only). */
export const VIEW_TYPE_BY_SOURCE: Record<string, string> = {
  report_sec016: "sec016",
  report_sec029: "sec029",
  report_sec014: "sec014",
  report_sec018: "sec018",
  report_sec033: "sec033",
  report_sec013: "sec013",
};

export interface EntityReportFilters {
  page: number;
  pageSize: number;
  registration: string | null;
  flight: string | null;
  from: string | null;
  to: string | null;
  sourceTable: string | null;
  status: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(v: string | undefined, max: number): string | null {
  const t = (v ?? "").trim().slice(0, max);
  return t === "" ? null : t;
}
function cleanDate(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!ISO_DATE.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}

export function parseEntityReportFilters(params: Record<string, string | undefined>): EntityReportFilters {
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const sourceTable = REPORT_TYPE_OPTIONS.some((o) => o.value === params.type) ? (params.type as string) : null;
  const status = REPORT_STATUS_OPTIONS.some((o) => o.value === params.status) ? (params.status as string) : null;
  let from = cleanDate(params.from);
  let to = cleanDate(params.to);
  if (from && to && from > to) {
    [from, to] = [to, from];
  }
  return {
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1,
    pageSize: 25,
    registration: cleanText(params.reg, 20),
    flight: cleanText(params.flight, 12),
    from,
    to,
    sourceTable,
    status,
  };
}

export function reportViewHref(sourceTable: string, sourceId: string): string | null {
  const type = VIEW_TYPE_BY_SOURCE[sourceTable];
  return type ? `/avsec/reports/view/${type}/${sourceId}` : null;
}
