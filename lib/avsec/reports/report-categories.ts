import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";

/**
 * Security-report categories shown wherever a person picks a report to FILE. Pure (no framework imports) so the membership and
 * the per-person filtering are unit-testable. This is display grouping only: which forms a person may create stays the database's
 * decision (report_form_assignments / can_create_report_form), and every submit action and table trigger re-checks it.
 * Report categories: Daily, Aircraft, Makeup, and Breakup.
 */
export interface ReportCategory {
  id: "daily" | "aircraft" | "makeup" | "breakup";
  title: string;
  forms: readonly ReportType[];
}

export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  { id: "daily", title: "Daily Reports", forms: ["sec014", "sec013"] },
  { id: "aircraft", title: "Aircraft Reports", forms: ["sec016", "sec029", "sec018", "sec033"] },
  { id: "makeup", title: "Makeup Report", forms: ["makeup"] },
  { id: "breakup", title: "Breakup Report", forms: ["breakup"] },
];

export interface GroupedReportForm {
  type: ReportType;
  code: string;
  /** Title-cased form name without the trailing form-number suffix. */
  title: string;
  href: string;
}

export interface GroupedReportCategory {
  id: ReportCategory["id"];
  title: string;
  forms: GroupedReportForm[];
}

/** "ASO DAILY REPORT SEC 014" -> "ASO Daily Report" (the code line already carries the form number). */
export function reportDisplayTitle(type: ReportType): string {
  const raw = REPORT_META[type].name.replace(/\s+SEC\s*0\d+\s*$/i, "").trim();
  const small = new Set(["and", "of", "the"]);
  return raw
    .split(/\s+/)
    .map((w, i) => {
      if (w === "ASO") return w;
      const lower = w.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * Group ONLY the forms the caller is allowed to create (from the database-backed assignment list). A category with no permitted forms
 * is omitted. A form outside every category, such as the retired standalone Offload, is never shown.
 */
export function groupAllowedReportForms(allowed: readonly string[]): GroupedReportCategory[] {
  const permitted = new Set(allowed);
  return REPORT_CATEGORIES.map((c) => ({
    id: c.id,
    title: c.title,
    forms: c.forms
      .filter((t) => permitted.has(t))
      .map((t) => ({ type: t, code: REPORT_META[t].code, title: reportDisplayTitle(t), href: `/avsec/reports/${REPORT_META[t].route}` })),
  })).filter((c) => c.forms.length > 0);
}
