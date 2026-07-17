import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { getReportById } from "@/lib/reports/queries";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { Sec016View, Sec014View, Sec029View, Sec018View } from "@/components/reports/ReportView";
import { formatDateTimeMY } from "@/lib/datetime";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row } from "@/lib/types";

export default async function ReportViewPage({
  params,
}: {
  params: { type: string; id: string };
}) {
  const profile = await requireProfile();

  if (!REPORT_TYPES.includes(params.type as ReportType)) notFound();
  const type = params.type as ReportType;

  const report = await getReportById(type, params.id);
  if (!report) notFound();

  const meta = REPORT_META[type];

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title={meta.name} backHref="/history" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="form-code-badge">{meta.code}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Submitted {formatDateTimeMY((report as { submitted_at: string | null }).submitted_at)}
          </p>
        </div>

        <a href={`/api/export/pdf/${type}/${params.id}`} className="btn-secondary w-full" target="_blank">
          Download PDF (audit submission)
        </a>

        {type === "sec016" && <Sec016View report={report as unknown as Sec016Row} />}
        {type === "sec014" && <Sec014View report={report as unknown as Sec014Row} />}
        {type === "sec029" && <Sec029View report={report as unknown as Sec029Row} />}
        {type === "sec018" && <Sec018View report={report as unknown as Sec018Row} />}
      </div>
    </main>
  );
}
