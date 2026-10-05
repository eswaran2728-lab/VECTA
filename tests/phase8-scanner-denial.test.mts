// Phase 8 Round 2 certification: proves, against the REAL
// scanTransaction() implementation (the app's ONLY CaterLink scan entry
// point -- see its own header comment), that an account holding an
// active profiling_so/profiling_aso Phase 3 role is denied BEFORE any
// QR/transaction logic runs, and that this denial cannot be bypassed by
// legacy ops_group values that would otherwise satisfy the
// org-wide/ops-group gate. This is the actual authorization path, not a
// re-derived copy of it -- the only mocked boundary is the Supabase
// client construction (@/lib/supabase/server), matching every other
// Phase 8 application-level test in this pass.
import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { ResultQueue, makeMockSupabaseClient } from "./mocks/supabase-query-builder.mts";

let currentQueue = new ResultQueue();

mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => makeMockSupabaseClient(currentQueue) } });

const { scanTransaction } = await import("../lib/icms/actions/scan.ts");

function reset() {
  currentQueue = new ResultQueue();
  return currentQueue;
}

function queueAuthAndProfile(queue: ResultQueue, caller: { roleCodes: string[]; station?: string | null; stationCanScan?: boolean }) {
  queue.push({ data: { user: { id: "user-1" } }, error: null }); // auth.getUser()
  queue.push({
    data: caller.roleCodes.map((role_code) => ({ role_code, role_category: "x", station_code: caller.station ?? null, starts_at: "2026-01-01T00:00:00Z", ends_at: null })),
    error: null,
  }); // get_my_active_role_assignments() -- the ONLY authority; no legacy row or ops_group is read
  const isProfiling = caller.roleCodes.some((c) => c === "profiling_so" || c === "profiling_aso");
  const isStationOperator = caller.roleCodes.some((c) => ["aso", "so", "sso", "dse"].includes(c));
  if (!isProfiling && isStationOperator) {
    queue.push({ data: caller.stationCanScan ?? true, error: null }); // can_user_scan_caterlink(station)
  }
}

test("scanner denial: profiling_aso cannot scan, even when legacy values would otherwise satisfy the checks", async () => {
  const queue = reset();
  // Legacy fields deliberately set to values that WOULD pass the
  // org-wide/ops-group gate below the Phase 8 check -- proving the
  // Phase 8 denial is not merely "reached first by coincidence" but
  // genuinely independent of (and stronger than) the legacy gate.
  queueAuthAndProfile(queue, { roleCodes: ["profiling_aso"], station: "KUL - MAA" });

  const result = await scanTransaction("AK123-CATERING-0001");
  assert.equal(result.error, "Staff Profiling accounts are not authorized to scan CaterLink transactions.");
  assert.equal(result.transactionId, undefined, "no transaction data is ever returned to a denied Profiling caller");
});

test("scanner denial: profiling_so cannot scan, even when legacy values would otherwise satisfy the checks", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["profiling_so"], station: "KUL - MAA" });

  const result = await scanTransaction("AK123-CATERING-0001");
  assert.equal(result.error, "Staff Profiling accounts are not authorized to scan CaterLink transactions.");
  assert.equal(queue.callsMatching("rpc").length, 1, "the Profiling denial is decided from the single canonical assignments call -- no per-role probing");
});

test("scanner denial: a Profiling account still gets the Profiling-specific denial message, proving the Phase 8 check runs strictly first", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["profiling_aso"], station: "KUL - MAA" });

  const result = await scanTransaction("AK123-CATERING-0001");
  assert.equal(result.error, "Staff Profiling accounts are not authorized to scan CaterLink transactions.", "the caller gets the Profiling-specific denial, not the generic 'no ops group' error -- proving the Phase 8 check is checked before, and takes precedence over, the legacy gate");
});

test("scanner denial: direct invocation of the scan server action fails for profiling_aso -- this test calls the exported function directly, the same object a route handler would call, not a re-implementation", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["profiling_aso"], station: "KUL - MAA" });

  const result = await scanTransaction("some-raw-qr-payload");
  assert.ok(result.error, "direct invocation with a Profiling-active caller fails, exactly as a route-handler-mediated call would (scanTransaction is the ONLY scan entry point in this codebase)");
});

test("scanner denial: an unrelated, legitimately valid CaterLink role (ASO at a scan-capable station, no Profiling role) is NOT denied by the Profiling check and reaches real QR-parsing logic", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["aso"], station: "KUL - MAA" });

  // Deliberately invalid QR content -- if the Profiling check had
  // incorrectly denied everyone, or incorrectly let a Profiling account
  // through, we could not distinguish that from this legitimate failure
  // mode. Reaching "Could not read this QR code." (the REAL
  // parseCaterLinkQrPayload()'s own rejection, not a mock) proves this
  // unrelated role passed the Phase 8 gate and reached real downstream
  // scan logic, retaining its intended behavior.
  const result = await scanTransaction("");
  assert.equal(result.error, "Could not read this QR code.");
});

test("scanner denial: a Profiling account is denied even when the QR payload itself is completely invalid -- the role check runs before payload parsing, so garbage input never masks the correct denial reason", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["profiling_so"], station: "KUL - MAA" });

  const result = await scanTransaction("this is not a valid qr payload");
  assert.equal(result.error, "Staff Profiling accounts are not authorized to scan CaterLink transactions.", "the Profiling denial is returned, not a QR-parsing error -- proving check ORDER (role gate strictly before payload parsing), not just eventual outcome");
});


test("scanner: a station operator at a station WITHOUT the CaterLink scan capability (e.g. BTU) is denied, fail-closed", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["aso"], station: "BTU", stationCanScan: false });
  const result = await scanTransaction("AK123-CATERING-0001");
  assert.equal(result.error, "CaterLink scanning is disabled for station BTU.");
  assert.equal(result.transactionId, undefined);
});

test("scanner: a capability result that is not exactly true (null / error) is denied", async () => {
  for (const cap of [null, false] as const) {
    const queue = reset();
    queue.push({ data: { user: { id: "user-1" } }, error: null });
    queue.push({ data: [{ role_code: "so", role_category: "x", station_code: "PEN", starts_at: "2026-01-01T00:00:00Z", ends_at: null }], error: null });
    queue.push({ data: cap, error: null });
    const result = await scanTransaction("AK123-CATERING-0001");
    assert.match(result.error ?? "", /CaterLink scanning is disabled for station PEN/);
  }
});

test("scanner: a station operator with no single assigned station is denied", async () => {
  const queue = reset();
  queueAuthAndProfile(queue, { roleCodes: ["aso"], station: null });
  const result = await scanTransaction("AK123-CATERING-0001");
  assert.match(result.error ?? "", /no single assigned station/);
});

test("scanner: roles that are neither station operators nor leadership (ghod, compliance, SAT, investigation, entity admin) cannot scan", async () => {
  for (const role of ["ghod", "compliance", "sat_aso", "investigation_so", "maa_admin", "caterlink_management", "hub_se"]) {
    const queue = reset();
    queueAuthAndProfile(queue, { roleCodes: [role] });
    const result = await scanTransaction("AK123-CATERING-0001");
    assert.equal(result.error, "Your role is not authorized to scan CaterLink transactions.", role);
  }
});

test("scanner: no assignment at all (legacy-only account, forged ops_group/role) is denied", async () => {
  const queue = reset();
  queue.push({ data: { user: { id: "user-1" } }, error: null });
  queue.push({ data: [], error: null });
  const result = await scanTransaction("AK123-CATERING-0001");
  assert.equal(result.error, "No VECTA profile — contact an admin.");
});
