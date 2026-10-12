import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const DIR = "supabase/migrations";
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const stamp = (f: string) => f.slice(0, 14);

test("no two migrations share a 14-digit timestamp", () => {
  const seen = new Map<string, string>();
  for (const f of files) {
    if (!/^\d{14}_/.test(f)) continue;
    const s = stamp(f);
    assert.ok(!seen.has(s), `timestamp collision: ${seen.get(s)} / ${f}`);
    seen.set(s, f);
  }
});

test("the KCH/BKI, role-workspace and PDF-version migrations are in the proposed hosted order", () => {
  const order = [
    "20261027000002_hub_destinations_kch_bki.sql",
    "20261101000001", "20261101000002", "20261101000003", "20261101000004", "20261101000005",
    "20261102000001", "20261102000002", "20261102000003", "20261103000001", "20261104000001",
  ];
  const idx = order.map((o) => files.findIndex((f) => f.startsWith(o)));
  idx.forEach((i, n) => assert.ok(i >= 0, `${order[n]} exists`));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `${order[i]} sorts after ${order[i - 1]}`);
  // the destination widening must precede every pending 202611 migration
  assert.ok(files.findIndex((f) => f.startsWith("20261027000001")) < idx[0]);
});

test("the KCH/BKI migration replaces no function and enables no scanner", () => {
  const sql = fs.readFileSync(`${DIR}/20261027000002_hub_destinations_kch_bki.sql`, "utf8");
  assert.doesNotMatch(sql, /create (or replace )?function/i);
  assert.doesNotMatch(sql, /can_scan\s*=\s*true/i);
});

test("the PDF-version recorder is service-role only", () => {
  const sql = fs.readFileSync(`${DIR}/20261104000001_caterlink_receipt_pdf_version.sql`, "utf8");
  assert.match(sql, /revoke execute on function public\.record_caterlink_receipt_pdf_version[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.record_caterlink_receipt_pdf_version[\s\S]*to service_role/i);
});
