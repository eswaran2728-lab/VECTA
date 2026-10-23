import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isTransactionNumber } from "../lib/icms/qr-payload.ts";

test("manual reference entry accepts the current CaterLink movement number (CL-YYYY-NNNNNN) as well as the legacy ICMS / CSCS numbers", () => {
  for (const ok of ["CL-2026-000034", "cl-2026-000034", "ICMS-2026-000001", "CSCS-2025-123456"]) assert.equal(isTransactionNumber(ok), true, ok);
});

test("manual reference entry still rejects anything that is not a movement number (vendor delivery numbers, free text, partial numbers)", () => {
  for (const bad of ["CLV-2026-000001", "CL-2026-34", "CL2026000034", "hello", "", "CL-2026-000034; drop table transactions", "XX-2026-000034"]) assert.equal(isTransactionNumber(bad), false, bad);
});

test("the scanner uses the shared matcher, not a private legacy-only pattern", () => {
  const scan = fs.readFileSync("lib/icms/actions/scan.ts", "utf8");
  assert.match(scan, /isTransactionNumber\(ref\)/);
  assert.doesNotMatch(scan, /ICMS\|CSCS/);
});
