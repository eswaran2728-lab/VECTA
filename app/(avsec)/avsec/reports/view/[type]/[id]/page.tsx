import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getReportById } from "@/lib/avsec/reports/queries";
import { getAcknowledgement } from "@/lib/avsec/acknowledgements/queries";
import { acknowledgeReport } from "@/lib/avsec/acknowledgements/actions";
import { getReportAttachments } from "@/lib/avsec/attachments/actions";
import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, ROLE_RANK, type ReportType, type UserRole } from "@/lib/avsec/reference-data";
import { Sec016View, Sec014View, Sec029View, Sec018View, Sec033View, Sec013View } from "@/components/avsec/reports/ReportView";
import { AttachmentGallery } from "@/components/avsec/reports/AttachmentGallery";
import { formatDateTimeMY, formatTimeMY } from "@/lib/avsec/datetime";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row, Sec033Row, Sec013Row } from "@/lib/avsec/types";

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
      <div className="border-b border-border/80 bg-surface/80 backdrop-blur-md px-4 py-5">
        <div className="max-w-2xl mx-auto space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
              {meta.code}
            </span>
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Submitted
            </span>
          </div>
          <h1 className="font-display text-xl font-bold text-foreground">{meta.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">
            {formatDateTimeMY(submittedAt)}
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <a href={`/api/avsec/export/pdf/${type}/${params.id}`} className="btn-secondary w-full text-xs text-center" target="_blank">
          Download PDF (Audit Submission)
        </a>

        {(acknowledgement || canAcknowledge || searchParams.error) && (
          <div className="card p-4 space-y-2 border-border/80 bg-surface/80">
            {acknowledgement ? (
              <p className="text-xs font-mono text-emerald-400">
                ✓ Acknowledged by <strong>{acknowledgement.acknowledgedByName}</strong> on{" "}
                {formatDateTimeMY(acknowledgement.acknowledgedAt)}
              </p>
            ) : (
              canAcknowledge && (
                <form action={acknowledgeReport}>
                  <input type="hidden" name="reportType" value={type} />
                  <input type="hidden" name="reportId" value={params.id} />
                  <button type="submit" className="btn-primary w-full text-xs">
                    Acknowledge Report
                  </button>
                </form>
              )
            )}
            {searchParams.error && <p className="text-xs text-red-400 font-mono">{searchParams.error}</p>}
          </div>
        )}

        {type === "sec016" && <Sec016View report={report as unknown as Sec016Row} />}
        {type === "sec014" && <Sec014View report={report as unknown as Sec014Row} />}
        {type === "sec029" && <Sec029View report={report as unknown as Sec029Row} />}
        {type === "sec018" && <Sec018View report={report as unknown as Sec018Row} />}
        {type === "sec033" && <Sec033View report={report as unknown as Sec033Row} />}
        {type === "sec013" && <Sec013View report={report as unknown as Sec013Row} />}

        <AttachmentGallery attachments={attachments} />

        <section className="card p-4 sm:p-5 border-border/80 bg-surface/80 space-y-3">
          <h2 className="section-title">Record Trail</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-[60px_1fr] gap-3 items-start">
              <p className="font-mono text-xs text-muted-foreground">
                {formatTimeMY(submittedAt)}
              </p>
              <div className="relative pl-4 border-l border-border/60">
                <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-emerald-400" />
                <p className="font-bold text-xs text-foreground">
                  Submitted · Immutable
                </p>
                <p className="font-mono text-xs text-muted-foreground mt-0.5">
                  {profile.id === reportRow.profile_id ? profile.name : "Submitter"}
                </p>
              </div>
            </div>
            {acknowledgement && (
              <div className="grid grid-cols-[60px_1fr] gap-3 items-start">
                <p className="font-mono text-xs text-muted-foreground">
                  {formatTimeMY(acknowledgement.acknowledgedAt)}
                </p>
                <div className="relative pl-4 border-l border-border/60">
                  <span className="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full bg-primary" />
                  <p className="font-bold text-xs text-foreground">
                    Acknowledged
                  </p>
                  <p className="font-mono text-xs text-muted-foreground mt-0.5">
                    {acknowledgement.acknowledgedByName}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
