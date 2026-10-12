"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { runCaterlinkPdfJobs } from "@/lib/icms/completed-form-pdf";
import { getCaterlinkTransactionPdfDownloadUrl } from "@/lib/icms/actions/caterlink-pdf";

export interface PdfRetryResult {
  ok: boolean;
  error: string | null;
}

/**
 * Manual retry of a failed final-PDF job. Authorization is the database's: retry_caterlink_pdf_job_secure admits only CaterLink
 * Management of the transaction's AOC and answers uniformly for anything else. Only after it succeeds does the server run the worker.
 */
export async function retryFinalPdfJob(formData: FormData): Promise<PdfRetryResult> {
  await requireRole(["supervisor"]);
  const jobId = String(formData.get("jobId") || "");
  const transactionId = String(formData.get("transactionId") || "");
  if (!jobId || !transactionId) return { ok: false, error: "A job is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_caterlink_pdf_job_secure", { p_job_id: jobId });
  if (error) return { ok: false, error: "This PDF job cannot be retried." };
  try {
    await runCaterlinkPdfJobs({ transactionId, limit: 1 });
  } catch {
    /* the job stays queued; its status is shown on the page */
  }
  revalidatePath("/icms/admin/final-pdfs");
  return { ok: true, error: null };
}

/** Authorized download of the CURRENT final PDF (the RPC re-authorizes and audits every access). */
export async function downloadFinalPdf(formData: FormData): Promise<void> {
  await requireRole(["supervisor"]);
  const transactionId = String(formData.get("transactionId") || "");
  const res = await getCaterlinkTransactionPdfDownloadUrl(transactionId);
  if (!res.ok || !res.data) redirect("/icms/admin/final-pdfs?error=download");
  redirect(res.data.url);
}
