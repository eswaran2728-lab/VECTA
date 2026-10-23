import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("every supported final destination enqueues an atomic PDF job", () => {
  const sql = fs.readFileSync("supabase/migrations/20261120000001_caterlink_all_final_receipts_pdf.sql", "utf8");
  assert.match(sql, /create or replace function public\.enqueue_caterlink_receipt_pdf_job\(\)/i);
  assert.match(sql, /confirmed_destination in \('PEN', 'JHB', 'NILAI', 'KCH', 'BKI'\)/);
  assert.match(sql, /new\.status = 'COMPLETED' and old\.status is distinct from 'COMPLETED'/);
  assert.match(sql, /on conflict on constraint caterlink_pdf_jobs_idempotency_key_key do nothing/);
  assert.doesNotMatch(sql, /drop trigger|create trigger|delete from|truncate/i);
});
