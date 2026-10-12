/**
 * Post-receipt final-PDF worker (pure: every side effect is injected, so the failure paths are testable).
 *
 * A KCH / BKI receipt creates a caterlink_pdf_jobs row atomically with the completion (database trigger). This worker claims due
 * jobs, renders the completed form, uploads it to the private bucket and asks the database to record the version. At most one
 * authoritative version results per job: complete_caterlink_pdf_job() answers a finished job with its existing version no matter how
 * often it is processed again. A failure records only a CATEGORY (never a message, URL or secret) and schedules a retry.
 */
export type PdfFailureCategory = "render" | "storage" | "record" | "not_ready" | "unknown";

export interface ClaimedPdfJob {
  jobId: string;
  transactionId: string;
  receiver: string;
  attemptCount: number;
}

export interface PdfJobDeps {
  claim(limit: number, transactionId: string | null): Promise<ClaimedPdfJob[]>;
  /** Rendered bytes, or null when the transaction cannot be rendered yet. */
  render(transactionId: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<{ error: string | null }>;
  complete(jobId: string, path: string, hash: string, size: number): Promise<{ version: number | null; error: boolean }>;
  fail(jobId: string, category: PdfFailureCategory): Promise<void>;
}

export interface PdfJobOutcome {
  jobId: string;
  transactionId: string;
  ok: boolean;
  version: number | null;
  category: PdfFailureCategory | null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function processOne(deps: PdfJobDeps, job: ClaimedPdfJob): Promise<PdfJobOutcome> {
  const base = { jobId: job.jobId, transactionId: job.transactionId };
  const failWith = async (category: PdfFailureCategory): Promise<PdfJobOutcome> => {
    try { await deps.fail(job.jobId, category); } catch { /* the stale-lock reclaim recovers a job whose failure could not be recorded */ }
    return { ...base, ok: false, version: null, category };
  };

  let bytes: Uint8Array | null;
  try { bytes = await deps.render(job.transactionId); } catch { return failWith("render"); }
  if (!bytes) return failWith("not_ready");

  const hash = await sha256Hex(bytes);
  const path = `${job.transactionId}/${hash}.pdf`;
  try {
    const up = await deps.upload(path, bytes);
    if (up.error && !/already exists|duplicate/i.test(up.error)) return failWith("storage");
  } catch { return failWith("storage"); }

  try {
    const done = await deps.complete(job.jobId, path, hash, bytes.length);
    if (done.error) return failWith("record");
    return { ...base, ok: true, version: done.version, category: null };
  } catch { return failWith("record"); }
}

/** Claims up to `limit` due jobs (optionally only one transaction's) and processes each. Safe to run concurrently. */
export async function processPdfJobs(deps: PdfJobDeps, opts: { limit?: number; transactionId?: string | null } = {}): Promise<PdfJobOutcome[]> {
  const jobs = await deps.claim(opts.limit ?? 5, opts.transactionId ?? null);
  const out: PdfJobOutcome[] = [];
  for (const job of jobs) out.push(await processOne(deps, job));
  return out;
}
