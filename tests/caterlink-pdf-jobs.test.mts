import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { processPdfJobs, sha256Hex, type ClaimedPdfJob, type PdfFailureCategory, type PdfJobDeps } from "../lib/avsec/caterlink/pdf-jobs.ts";

const read = (p: string) => fs.readFileSync(p, "utf8");

/** In-memory model of the database contract (claim -> processing, fail -> retryable, complete -> one version per job). */
function makeWorld(opts: { render?: () => Promise<Uint8Array | null>; upload?: () => Promise<{ error: string | null }>; completeError?: boolean } = {}) {
  const job = { id: "job-1", tx: "tx-1", status: "pending" as string, attempts: 0, category: null as PdfFailureCategory | null, pdfId: null as string | null };
  const versions: { id: string; version: number; hash: string; current: boolean }[] = [{ id: "old", version: 1, hash: "old-hash", current: true }];
  const uploads: string[] = [];
  const stats = { renders: 0 };
  const deps: PdfJobDeps = {
    async claim(): Promise<ClaimedPdfJob[]> {
      if (job.status !== "pending" && job.status !== "failed_retryable") return [];
      job.status = "processing";
      job.attempts += 1;
      return [{ jobId: job.id, transactionId: job.tx, receiver: "rc", attemptCount: job.attempts }];
    },
    async render() { stats.renders += 1; return opts.render ? opts.render() : new TextEncoder().encode(`pdf-${stats.renders}`); },
    async upload(path) { const r = opts.upload ? await opts.upload() : { error: null }; if (!r.error) uploads.push(path); return r; },
    async complete(_id, _path, hash) {
      if (opts.completeError) return { version: null, error: true };
      if (job.status === "succeeded") return { version: versions.find((v) => v.id === job.pdfId)!.version, error: false };
      versions.forEach((v) => (v.current = false));
      const v = { id: `v${versions.length + 1}`, version: versions.length + 1, hash, current: true };
      versions.push(v);
      job.status = "succeeded"; job.pdfId = v.id;
      return { version: v.version, error: false };
    },
    async fail(_id, category) { if (job.status === "processing") { job.status = "failed_retryable"; job.category = category; } },
  };
  return { job, versions, uploads, deps, stats };
}

test("successful generation: one new authoritative version, previous version preserved", async () => {
  const w = makeWorld();
  const out = await processPdfJobs(w.deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
  assert.equal(out[0].version, 2);
  assert.equal(w.job.status, "succeeded");
  assert.deepEqual(w.versions.map((v) => [v.version, v.current]), [[1, false], [2, true]]);
  assert.match(w.uploads[0], /^tx-1\/[0-9a-f]{64}\.pdf$/);
});

test("rendering failure: retryable with a category, nothing uploaded or recorded", async () => {
  const w = makeWorld({ render: async () => { throw new Error("secret detail https://x?token=abc"); } });
  const out = await processPdfJobs(w.deps);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].category, "render");
  assert.equal(w.job.status, "failed_retryable");
  assert.equal(w.job.category, "render");
  assert.equal(w.uploads.length, 0);
  assert.equal(w.versions.length, 1);
  assert.ok(!JSON.stringify(w.job).match(/token|secret|https?:/i), "no error text is retained");
});

test("a transaction that cannot be rendered yet is 'not_ready' (retryable)", async () => {
  const w = makeWorld({ render: async () => null });
  assert.equal((await processPdfJobs(w.deps))[0].category, "not_ready");
});

test("Storage failure: retryable, no version recorded; an 'already exists' upload is tolerated", async () => {
  const bad = makeWorld({ upload: async () => ({ error: "bucket unavailable https://signed.example/?token=zzz" }) });
  const out = await processPdfJobs(bad.deps);
  assert.equal(out[0].category, "storage");
  assert.equal(bad.versions.length, 1);
  assert.equal(bad.job.status, "failed_retryable");
  const dup = makeWorld({ upload: async () => ({ error: "The resource already exists" }) });
  assert.equal((await processPdfJobs(dup.deps))[0].ok, true);
});

test("recording failure is categorised 'record'", async () => {
  const w = makeWorld({ completeError: true });
  assert.equal((await processPdfJobs(w.deps))[0].category, "record");
});

test("retry success after a failure, then repeated processing returns the existing version without a second one", async () => {
  let fail = true;
  const w = makeWorld({ upload: async () => (fail ? { error: "down" } : { error: null }) });
  assert.equal((await processPdfJobs(w.deps))[0].ok, false);
  fail = false;
  const second = await processPdfJobs(w.deps);
  assert.equal(second[0].ok, true);
  assert.equal(second[0].version, 2);
  const third = await processPdfJobs(w.deps); // nothing claimable any more
  assert.equal(third.length, 0);
  assert.equal(w.versions.length, 2, "exactly one new authoritative version (plus the preserved earlier one)");
  assert.equal(w.stats.renders, 2, "a finished job is not rendered again");
});

test("concurrent workers: only one claims the job, exactly one version results", async () => {
  const w = makeWorld();
  const [a, b] = await Promise.all([processPdfJobs(w.deps), processPdfJobs(w.deps)]);
  assert.equal(a.length + b.length, 1);
  assert.equal(w.versions.length, 2);
});

test("sha256Hex is the stable lowercase SHA-256", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("receipt flow: the receipt is committed first, a PDF is reported ready only when a version exists, no untyped cast remains", () => {
  const receipt = read("lib/avsec/caterlink/receipt.ts");
  assert.ok(receipt.indexOf("confirm_caterlink_destination_receipt_secure") < receipt.lastIndexOf("runCaterlinkPdfJobs"));
  assert.match(receipt, /pdfVersion = outcomes\.find\(\(o\) => o\.ok\)\?\.version \?\? null/);
  const form = read("components/avsec/caterlink/ReceiptForm.tsx");
  assert.match(form, /is ready\./);
  assert.match(form, /PDF is pending/);
  const worker = read("lib/icms/completed-form-pdf.ts");
  assert.doesNotMatch(worker, /as unknown as \(n: string/);
  assert.doesNotMatch(worker, /regenerateFinalPdfAfterReceipt/);
});

test("manual retry: authorization is the database's; the server runs the worker only after it succeeds; page and downloads are gated", () => {
  const act = read("lib/icms/actions/pdf-jobs.ts");
  assert.match(act, /requireRole\(\["supervisor"\]\)/);
  assert.ok(act.indexOf("retry_caterlink_pdf_job_secure") < act.lastIndexOf("runCaterlinkPdfJobs"));
  assert.match(act, /if \(error\) return \{ ok: false/);
  assert.match(read("app/(icms)/icms/admin/final-pdfs/page.tsx"), /requireRole\(\["supervisor"\]\)/);
  const page = read("app/(icms)/icms/admin/final-pdfs/page.tsx");
  assert.match(page, /PDF pending/);
  assert.match(page, /PDF generation failed/);
  assert.match(page, /list_caterlink_pdf_jobs_secure/);
});

test("job table holds no message/URL columns and is service-role only; worker functions are service-role only", () => {
  const sql = read("supabase/migrations/20261105000001_caterlink_pdf_generation_jobs.sql");
  assert.doesNotMatch(sql, /last_error\s+text|error_message|signed_url/i);
  assert.match(sql, /revoke all on public\.caterlink_pdf_jobs from public, anon, authenticated/);
  for (const fn of ["claim_caterlink_pdf_jobs\\(integer, uuid\\)", "complete_caterlink_pdf_job\\(uuid, text, text, integer\\)", "fail_caterlink_pdf_job\\(uuid, text\\)"]) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`));
  }
  assert.match(sql, /unique \(idempotency_key\)/);
  assert.match(sql, /has_active_role_for_aoc\('caterlink_management'/);
});
