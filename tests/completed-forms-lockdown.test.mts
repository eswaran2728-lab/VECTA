import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

test("completed-forms has no active producer or consumer: the generators and reader helpers are called by nothing outside their own modules", () => {
  const files = [...walk("lib"), ...walk("app"), ...(fs.existsSync("components") ? walk("components") : [])];
  const own = new Set(["lib/icms/completed-form-pdf.ts", "lib/icms/completed-form-pdf-vendor.ts"].map((f) => path.normalize(f)));
  for (const fn of ["generateCompletedFormPdf", "generateVendorCompletedFormPdf"]) {
    const callers = files.filter((f) => !own.has(path.normalize(f)) && fs.readFileSync(f, "utf8").includes(fn));
    assert.deepEqual(callers, [], `${fn} is wired in: ${callers.join(", ")} -- the bucket is fail-closed, so a caller needs a reviewed policy first`);
  }
  // nothing signs or reads a completed-forms object
  const readers = files.filter((f) => /signedUrl\(\s*"completed-forms"/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(readers, [], "a reader of completed-forms exists");
  // the only code that uploads to the bucket is the two (uncalled) generators
  const writers = files.filter((f) => /uploadPdfBuffer\(\s*"completed-forms"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.normalize(f)).sort();
  assert.deepEqual(writers, [...own].sort());
  // and the live PDF flow does not touch the bucket
  const jobs = fs.readFileSync("lib/icms/completed-form-pdf.ts", "utf8");
  const run = jobs.slice(jobs.indexOf("export async function runCaterlinkPdfJobs"));
  assert.ok(!run.includes("completed-forms"), "runCaterlinkPdfJobs must not use the completed-forms bucket");
});

test("migration: drops both broad policies, adds nothing for clients, deletes no object", () => {
  const sql = fs.readFileSync("supabase/migrations/20261116000001_completed_forms_lockdown.sql", "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /drop policy if exists "completed forms: authenticated upload" on storage\.objects/);
  assert.match(sql, /drop policy if exists "completed forms: authenticated read" on storage\.objects/);
  assert.doesNotMatch(sql, /create policy/i, "no replacement policy: client access stays fully denied");
  assert.doesNotMatch(sql, /create (or replace )?function|security definer|auth\.role\(\)|user_metadata|app_metadata/i);
  assert.doesNotMatch(sql, /delete\s+from|truncate|drop\s+table|update\s+storage/i, "no stored object is touched");
  assert.doesNotMatch(sql, /storage\.buckets/i, "the bucket row (private) is untouched");
});

test("documentation records the inventory and the fail-closed rationale", () => {
  const doc = fs.readFileSync("docs/dashboard-review/completed-forms-lockdown.md", "utf8");
  for (const must of [/generateCompletedFormPdf/, /generateVendorCompletedFormPdf/, /0 objects/, /fail[- ]closed/i, /service[_ ]role/i, /caterlink-final-pdfs/]) assert.match(doc, must);
});
