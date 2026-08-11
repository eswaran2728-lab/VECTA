import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { getReportById } from "@/lib/reports/queries";
import { getAcknowledgement } from "@/lib/acknowledgements/queries";
import { acknowledgeReport } from "@/lib/acknowledgements/actions";
import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, ROLE_RANK, type ReportType, type UserRole } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { Sec016View, Sec014View, Sec029View, Sec018View, Sec033View, Sec013View } from "@/components/reports/ReportView";
import { formatDateTimeMY } from "@/lib/datetime";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row, Sec033Row, Sec013Row } from "@/lib/types";

export default async function ReportViewPage({
  params,
  searchParams,
}: {
  params: { type: string; id: string };
  searchParams: { error?: string };
}) {
  const profile = await requireProfile();

  if (!REPORT_TYPES.includes(params.type as ReportType)) notFound();
  const type = params.type as ReportType;

  const report = await getReportById(type, params.id);
  if (!report) notFound();

  const meta = REPORT_META[type];
  const reportRow = report as unknown as { profile_id: string; station: string; team: string; status: string };

  const [acknowledgement, submitter] = await Promise.all([
    getAcknowledgement(type, params.id),
    reportRow.profile_id === profile.id
      ? Promise.resolve(null)
      : createClient()
          .from("profiles")
          .select("role, station, team")
          .eq("id", reportRow.profile_id)
          .maybeSingle()
          .then((r) => r.data as { role: UserRole; station: string; team: string } | null),
  ]);

  const canAcknowledge =
    reportRow.status === "submitted" &&
    !acknowledgement &&
    submitter !== null &&
    ROLE_RANK[profile.role] === ROLE_RANK[submitter.role] + 1 &&
    profile.station === submitter.station &&
    (profile.team ?? "") === (submitter.team ?? "");

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

        {(acknowledgement || canAcknowledge || searchParams.error) && (
          <div className="card p-4 space-y-2">
            {acknowledgement ? (
              <p className="text-sm text-green-700 dark:text-green-400">
                ✓ Acknowledged by <strong>{acknowledgement.acknowledgedByName}</strong> on{" "}
                {formatDateTimeMY(acknowledgement.acknowledgedAt)}
              </p>
            ) : (
              canAcknowledge && (
                <form action={acknowledgeReport}>
                  <input type="hidden" name="reportType" value={type} />
                  <input type="hidden" name="reportId" value={params.id} />
                  <button type="submit" className="btn-primary w-full">
                    Acknowledge report
                  </button>
                </form>
              )
            )}
            {searchParams.error && <p className="field-error">{searchParams.error}</p>}
          </div>
        )}

        {type === "sec016" && <Sec016View report={report as unknown as Sec016Row} />}
        {type === "sec014" && <Sec014View report={report as unknown as Sec014Row} />}
        {type === "sec029" && <Sec029View report={report as unknown as Sec029Row} />}
        {type === "sec018" && <Sec018View report={report as unknown as Sec018Row} />}
        {type === "sec033" && <Sec033View report={report as unknown as Sec033Row} />}
        {type === "sec013" && <Sec013View report={report as unknown as Sec013Row} />}
      </div>
    </main>
  );
}
