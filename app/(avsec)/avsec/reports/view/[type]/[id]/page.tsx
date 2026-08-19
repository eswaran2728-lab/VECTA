import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getReportById } from "@/lib/avsec/reports/queries";
import { getAcknowledgement } from "@/lib/avsec/acknowledgements/queries";
import { acknowledgeReport } from "@/lib/avsec/acknowledgements/actions";
import { getReportAttachments } from "@/lib/avsec/attachments/actions";
import { createClient } from "@/lib/avsec/supabase/server";
import { REPORT_META, REPORT_TYPES, ROLE_RANK, type ReportType, type UserRole } from "@/lib/avsec/reference-data";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { BottomNav } from "@/components/avsec/layout/BottomNav";
import { Sec016View, Sec014View, Sec029View, Sec018View, Sec033View, Sec013View, OffloadView } from "@/components/avsec/reports/ReportView";
import { AttachmentGallery } from "@/components/avsec/reports/AttachmentGallery";
import { formatDateTimeMY, formatTimeMY } from "@/lib/avsec/datetime";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row, Sec033Row, Sec013Row, OffloadRow } from "@/lib/avsec/types";

export default async function ReportViewPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();

  if (!REPORT_TYPES.includes(params.type as ReportType)) notFound();
  const type = params.type as ReportType;

  const report = await getReportById(type, params.id);
  if (!report) notFound();

  const meta = REPORT_META[type];
  const reportRow = report as unknown as { profile_id: string; station: string; team: string; status: string };

  const [acknowledgement, submitter, attachments] = await Promise.all([
    getAcknowledgement(type, params.id),
    reportRow.profile_id === profile.id
      ? Promise.resolve(null)
      : (await createClient())
          .from("profiles")
          .select("role, station, team")
          .eq("id", reportRow.profile_id)
          .maybeSingle()
          .then((r) => r.data as { role: UserRole; station: string; team: string } | null),
    getReportAttachments(type, params.id),
  ]);

  const canAcknowledge =
    reportRow.status === "submitted" &&
    !acknowledgement &&
    submitter !== null &&
    ROLE_RANK[profile.role] === ROLE_RANK[submitter.role] + 1 &&
    profile.station === submitter.station &&
    (profile.team ?? "") === (submitter.team ?? "");

  const submittedAt = (report as { submitted_at: string | null }).submitted_at;

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title={meta.name} backHref="/avsec/history" />

      <div style={{ background: "var(--view-header)", borderBottom: "1px solid var(--line)" }} className="px-4 py-5">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between gap-2">
            <span className="t-mono text-[10px]" style={{ color: "var(--mid)" }}>
              {meta.code}
            </span>
            <span
              className="t-mono text-[9px] font-bold uppercase px-2.5 py-1"
              style={{ letterSpacing: "0.14em", background: "var(--gold-fill)", color: "var(--on-gold)" }}
            >
              Submitted
            </span>
          </div>
          <h1 className="t-display text-xl mt-3">{meta.name}</h1>
          <p className="t-mono text-[10px] mt-2" style={{ color: "var(--soft)" }}>
            {formatDateTimeMY(submittedAt)}
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <a href={`/api/avsec/export/pdf/${type}/${params.id}`} className="btn-secondary w-full" target="_blank">
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
        {type === "offload" && <OffloadView report={report as unknown as OffloadRow} />}

        <AttachmentGallery attachments={attachments} />

        <section className="card p-4 sm:p-5">
          <h2 className="section-title mb-3">Record Trail</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-[44px_1fr] gap-3">
              <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                {formatTimeMY(submittedAt)}
              </p>
              <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                <span
                  className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                  style={{ background: "var(--gold-fill)" }}
                />
                <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                  Submitted · immutable
                </p>
                <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                  {profile.id === reportRow.profile_id ? profile.name : "Submitter"}
                </p>
              </div>
            </div>
            {acknowledgement && (
              <div className="grid grid-cols-[44px_1fr] gap-3">
                <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                  {formatTimeMY(acknowledgement.acknowledgedAt)}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span
                    className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                    style={{ background: "var(--blue)" }}
                  />
                  <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                    Acknowledged
                  </p>
                  <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                    {acknowledgement.acknowledgedByName}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
