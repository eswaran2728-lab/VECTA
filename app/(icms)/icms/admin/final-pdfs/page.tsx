import type { Metadata } from "next";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/icms/ui/card";
import { Button } from "@/components/icms/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/icms/ui/table";
import { formatDateTime } from "@/lib/icms/utils";
import { retryFinalPdfJob, downloadFinalPdf } from "@/lib/icms/actions/pdf-jobs";

export const metadata: Metadata = { title: "Final PDFs" };
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  pending: "PDF pending",
  processing: "PDF pending",
  failed_retryable: "PDF generation failed (will retry)",
  failed_permanent: "PDF generation failed (manual retry needed)",
  succeeded: "PDF ready",
};
const CATEGORY: Record<string, string> = { render: "rendering", storage: "storage", record: "recording", not_ready: "not ready", unknown: "unknown" };

/** CaterLink Management view of the durable final-PDF jobs created by KCH / BKI receipts. A PDF is "ready" only once its version exists. */
export default async function FinalPdfsPage({ searchParams }: { searchParams: Promise<{ all?: string; error?: string }> }) {
  await requireRole(["supervisor"]);
  const params = await searchParams;
  const showAll = params.all === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_caterlink_pdf_jobs_secure", { p_only_open: !showAll });
  const jobs = data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Final PDFs</h1>
        <p className="text-sm text-muted-foreground">
          Final PDFs generated after a destination receipt. A document is only ready once its version exists; failures retry automatically and can be retried here.
        </p>
        <a className="text-xs underline" href={showAll ? "/icms/admin/final-pdfs" : "/icms/admin/final-pdfs?all=1"}>
          {showAll ? "Show open jobs only" : "Show completed jobs too"}
        </a>
      </div>
      {params.error === "download" && (
        <p className="text-sm text-red-500" role="alert">
          The final PDF could not be downloaded.
        </p>
      )}
      {error && (
        <p className="text-sm text-red-500" role="alert">
          The PDF jobs could not be loaded right now.
        </p>
      )}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last failure</TableHead>
                <TableHead>Next retry</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground" role="status">
                    No PDF jobs{showAll ? "" : " need attention"}.
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((j) => (
                  <TableRow key={j.job_id}>
                    <TableCell className="font-mono">{j.transaction_number}</TableCell>
                    <TableCell>{j.status === "succeeded" ? `PDF ready (version ${j.pdf_version ?? "?"})` : (LABEL[j.status] ?? j.status)}</TableCell>
                    <TableCell>{j.attempt_count}</TableCell>
                    <TableCell>{j.last_error_category ? (CATEGORY[j.last_error_category] ?? "unknown") : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{j.status === "succeeded" ? "—" : formatDateTime(j.next_retry_at)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(j.updated_at)}</TableCell>
                    <TableCell>
                      {(j.status === "failed_retryable" || j.status === "failed_permanent") && (
                        <form
                          action={async (fd) => {
                            "use server";
                            await retryFinalPdfJob(fd);
                          }}
                        >
                          <input type="hidden" name="jobId" value={j.job_id} />
                          <input type="hidden" name="transactionId" value={j.transaction_id} />
                          <Button type="submit" variant="outline" className="min-h-[44px]">
                            Retry
                          </Button>
                        </form>
                      )}
                      {j.status === "succeeded" && (
                        <form action={downloadFinalPdf}>
                          <input type="hidden" name="transactionId" value={j.transaction_id} />
                          <Button type="submit" variant="outline" className="min-h-[44px]">
                            Download
                          </Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
