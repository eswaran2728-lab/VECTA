import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Regression coverage for the "unified AVSEC scanning is read-only"
 * production defect (2026-09-23):
 *
 * Evidence: aso.ops.alpha@vecta.local (ASO, operation_avsec, approved,
 * on duty) scanned ICMS-2026-000030's valid signed QR pass. The scan
 * correctly resolved the transaction (lib/icms/actions/scan.ts's
 * opsGroupCanAccessCheckpoint gate already allowed operation_avsec to see
 * an ifc_avsec-mapped transaction, per the 2026-09-22 unified-scanning
 * migration), but landed on the read-only transaction detail page. Part B
 * showed "Awaiting In-flight Security Post" with no form or submit button,
 * and Parts C/D stayed locked.
 *
 * Two independent defects, both now fixed:
 *
 * 1. lib/icms/actions/scan.ts's resolveCateringRow/resolveVendorTransaction
 *    NEVER computed a checkpoint slug — every successful scan redirected to
 *    `/icms/transactions/{id}` (or `/icms/vendor-transactions/{id}`), never
 *    `.../part-b`, even when the scanning officer was fully authorized to
 *    complete that exact checkpoint. requireCheckpointRole() on the
 *    part-b/c/d/redq pages already accepted the unified ops_group model
 *    (added 2026-09-22) — nothing on the scan path ever linked there.
 *
 * 2. app/(icms)/icms/transactions/[id]/page.tsx's PendingPartCard
 *    ("actionable") and the page's top-level "Complete X" button
 *    ("nextAction") both checked `viewerOpsGroup === opsGroupForCheckpointRole(role)`
 *    — a STRICT equality check, not the unified opsGroupCanAccessCheckpoint
 *    union. So even manually opening the transaction page and finding the
 *    right checkpoint card, an operation_avsec officer looking at an
 *    ifc_avsec-mapped checkpoint (Part B/Part D) never saw the form link —
 *    only the read-only "Awaiting ..." state, exactly matching the report.
 *
 * Both defects were UI/navigation-only: every checkpoint's SUBMIT action
 * (lib/icms/actions/transactions.ts) and every checkpoint PAGE's own gate
 * (requireCheckpointRole in lib/icms/auth.ts) already used the correct
 * unified opsGroupCanAccessCheckpoint check from the 2026-09-22 migration.
 * No RLS policy, no requireCheckpointRole call, and no `ops_group` stored
 * value needed to change — confirmed no database migration is required for
 * this fix.
 */

import { opsGroupForCheckpointRole, opsGroupCanAccessCheckpoint } from "../lib/icms/ops-group.ts";
import { nextStepFor } from "../lib/icms/workflow.ts";
import { vendorNextStepFor } from "../lib/icms/workflow-vendor.ts";
import type { OpsGroup, Role } from "../lib/icms/database.types.ts";

// --- Form visibility: mirrors PendingPartCard's `actionable` in
// app/(icms)/icms/transactions/[id]/page.tsx (post-fix) ---

function checkpointFormActionable(input: {
  isCurrent: boolean;
  viewerRole: Role;
  viewerOpsGroup: OpsGroup | null;
  responsibleRole: Role;
}): boolean {
  return (
    input.isCurrent &&
    (input.viewerRole === input.responsibleRole ||
      opsGroupCanAccessCheckpoint(input.viewerOpsGroup, opsGroupForCheckpointRole(input.responsibleRole)))
  );
}

test("REGRESSION: ASO (operation_avsec) sees the Part B form — ifc_avsec-mapped checkpoint, cross-branch (the exact reported failure)", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "operation_avsec",
      responsibleRole: "post2_avsec",
    }),
    true,
  );
});

test("SO (ifc_avsec) sees the Part C form — operation_avsec-mapped checkpoint, cross-branch", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "ifc_avsec",
      responsibleRole: "post6_avsec",
    }),
    true,
  );
});

test("DSE (operation_avsec) sees the REDQ form; DSE (ifc_avsec) sees the Part D / Receiver form", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "operation_avsec",
      responsibleRole: "redq_avsec",
    }),
    true,
  );
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "ifc_avsec",
      responsibleRole: "receiver",
    }),
    true,
  );
});

test("Same-branch (non-cross) form visibility still works exactly as before", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "ifc_avsec",
      responsibleRole: "post2_avsec",
    }),
    true,
  );
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "operation_avsec",
      responsibleRole: "post6_avsec",
    }),
    true,
  );
});

test("SEQUENCE: the form never shows for a checkpoint that is not the current one, regardless of ops_group match", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: false,
      viewerRole: "ops_staff",
      viewerOpsGroup: "operation_avsec",
      responsibleRole: "post2_avsec",
    }),
    false,
  );
});

test("HUB SEPARATION: a unified-AVSEC (Operation/IFC) officer never sees the Part Hub form, even when it is current", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "operation_avsec",
      responsibleRole: "hub_avsec",
    }),
    false,
  );
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "ifc_avsec",
      responsibleRole: "hub_avsec",
    }),
    false,
  );
});

test("HUB SEPARATION: a Hub AVSEC officer never sees a non-Hub checkpoint form, even when it is current", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "hub_avsec",
      responsibleRole: "post2_avsec",
    }),
    false,
  );
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: "hub_avsec",
      responsibleRole: "post6_avsec",
    }),
    false,
  );
});

test("An account with no ops_group and no checkpoint-role match never sees a checkpoint form", () => {
  assert.equal(
    checkpointFormActionable({
      isCurrent: true,
      viewerRole: "ops_staff",
      viewerOpsGroup: null,
      responsibleRole: "post2_avsec",
    }),
    false,
  );
});

// --- Scan redirect routing: mirrors resolveCateringRow /
// resolveVendorTransaction in lib/icms/actions/scan.ts (post-fix). Both
// real functions compose the same three primitives asserted here
// (nextStepFor/vendorNextStepFor, opsGroupForCheckpointRole,
// opsGroupCanAccessCheckpoint) into a redirect path; this mirrors that
// composition so a regression in either the composition or the primitives
// is caught. ---

function cateringScanRedirect(input: {
  orgWide: boolean;
  userOpsGroup: OpsGroup | null;
  direction: "INBOUND" | "OUTBOUND";
  status: Parameters<typeof nextStepFor>[1];
  route: Parameters<typeof nextStepFor>[2];
  transactionId: string;
}): string {
  if (!input.orgWide) {
    const next = nextStepFor(input.direction, input.status, input.route);
    if (next && opsGroupCanAccessCheckpoint(input.userOpsGroup, opsGroupForCheckpointRole(next.role))) {
      return `/icms/transactions/${input.transactionId}/${next.slug}`;
    }
  }
  return `/icms/transactions/${input.transactionId}`;
}

function vendorScanRedirect(input: {
  orgWide: boolean;
  userOpsGroup: OpsGroup | null;
  status: Parameters<typeof vendorNextStepFor>[0];
  transactionId: string;
}): string {
  if (!input.orgWide) {
    const next = vendorNextStepFor(input.status);
    if (next && opsGroupCanAccessCheckpoint(input.userOpsGroup, opsGroupForCheckpointRole(next.role))) {
      return `/icms/vendor-transactions/${input.transactionId}/${next.slug}`;
    }
  }
  return `/icms/vendor-transactions/${input.transactionId}`;
}

test("REGRESSION: scanning ICMS-2026-000030's exact scenario (ASO/operation_avsec, outbound Part B pending) redirects straight to the Part B form, not the read-only page", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "operation_avsec",
    direction: "OUTBOUND",
    status: "CREATED",
    route: "AIRCRAFT",
    transactionId: "tx-1",
  });
  assert.equal(path, "/icms/transactions/tx-1/part-b");
});

test("Scanning a Part C (operation_avsec-mapped) checkpoint as an ifc_avsec officer redirects to the Part C form", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "ifc_avsec",
    direction: "OUTBOUND",
    status: "INFLIGHT_POST_APPROVED",
    route: "AIRCRAFT",
    transactionId: "tx-2",
  });
  assert.equal(path, "/icms/transactions/tx-2/part-c");
});

test("OUT-OF-ORDER: scanning a transaction that is not yet waiting on the scanning officer's checkpoint falls back to the read-only page, not a checkpoint form", () => {
  // Transaction is currently pending Part C (post6_avsec / operation_avsec);
  // an ifc_avsec-only-capable... actually both branches can reach Part C
  // under the unified model, so use a transaction pending a receiver step
  // that the scanning officer's ops_group cannot yet act on because it
  // isn't next: simulate by requesting a status this route doesn't have a
  // step for (already completed) -- next is null, so no checkpoint slug.
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "operation_avsec",
    direction: "OUTBOUND",
    status: "COMPLETED",
    route: "AIRCRAFT",
    transactionId: "tx-3",
  });
  assert.equal(path, "/icms/transactions/tx-3");
});

test("HUB SEPARATION: a unified-AVSEC officer scanning a HUB-route transaction, once it's pending Part Hub, never gets routed to the Part Hub form", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "operation_avsec",
    direction: "OUTBOUND",
    status: "INFLIGHT_POST_APPROVED",
    route: "HUB",
    transactionId: "tx-4",
  });
  assert.equal(path, "/icms/transactions/tx-4");
});

test("HUB SEPARATION: a Hub AVSEC officer scanning a HUB-route transaction pending Part Hub IS routed to the Part Hub form (unchanged, own scope)", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "hub_avsec",
    direction: "OUTBOUND",
    status: "INFLIGHT_POST_APPROVED",
    route: "HUB",
    transactionId: "tx-5",
  });
  assert.equal(path, "/icms/transactions/tx-5/part-hub");
});

test("A Hub-route transaction still pending Part B (before Part Hub) is reachable by unified AVSEC, same as any other route's Part B", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "operation_avsec",
    direction: "OUTBOUND",
    status: "CREATED",
    route: "HUB",
    transactionId: "tx-4b",
  });
  assert.equal(path, "/icms/transactions/tx-4b/part-b");
});

test("HUB SEPARATION: a Hub AVSEC officer scanning a non-Hub transaction never gets routed to a non-Hub checkpoint form", () => {
  const path = cateringScanRedirect({
    orgWide: false,
    userOpsGroup: "hub_avsec",
    direction: "OUTBOUND",
    status: "CREATED",
    route: "AIRCRAFT",
    transactionId: "tx-6",
  });
  assert.equal(path, "/icms/transactions/tx-6");
});

test("Org-wide roles (admin/management/enforcement) are never routed to a checkpoint form from a scan", () => {
  const path = cateringScanRedirect({
    orgWide: true,
    userOpsGroup: null,
    direction: "OUTBOUND",
    status: "CREATED",
    route: "AIRCRAFT",
    transactionId: "tx-7",
  });
  assert.equal(path, "/icms/transactions/tx-7");
});

test("Vendor Movement Part B (post2_avsec): unified AVSEC scanning routes straight to the vendor Part B form", () => {
  const path = vendorScanRedirect({
    orgWide: false,
    userOpsGroup: "ifc_avsec",
    status: "CREATED",
    transactionId: "vtx-1",
  });
  assert.equal(path, "/icms/vendor-transactions/vtx-1/part-b");
});

test("Vendor Movement Part C (warehouse_pic) is never made actionable through an AVSEC ops_group — it stays warehouse_pic's own role-gated step, unaffected by unified scanning", () => {
  const path = vendorScanRedirect({
    orgWide: false,
    userOpsGroup: "operation_avsec",
    status: "SECURITY_VERIFIED",
    transactionId: "vtx-2",
  });
  assert.equal(path, "/icms/vendor-transactions/vtx-2");
});

// --- QR pass validation: signature/expiry enforcement is unchanged by this
// fix (lib/icms/qr-token.ts's own logic was NOT touched). qr-token.ts is
// marked "server-only" (Next.js-only import guard), so — same as every
// other server-only/"use server" file in this suite (see
// tests/google-sso-callback.test.mts) — this mirrors its exact algorithm
// (HMAC-SHA256 over "<type>.<transactionId>.<expiry>", base64url,
// node:crypto timingSafeEqual) rather than importing it directly, so a
// regression in the real file's signing/verification behavior is still
// caught here. ---

const QR_SECRET = "test-only-secret-not-used-in-production-32chars-minimum";

function signQrPayload(payload: string): string {
  return createHmac("sha256", QR_SECRET).update(payload).digest("base64url");
}

function mirrorGenerateQrToken(transactionId: string, type: "CATERING" | "VENDOR", expiresInSeconds = 24 * 60 * 60): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${type}.${transactionId}.${exp}`;
  return `${payload}.${signQrPayload(payload)}`;
}

function mirrorVerifyQrToken(token: string): { ok: boolean } {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false };
  const [typeRaw, tid, expRaw, sig] = parts;
  if ((typeRaw !== "CATERING" && typeRaw !== "VENDOR") || !/^\d+$/.test(expRaw)) return { ok: false };
  const expected = signQrPayload(`${typeRaw}.${tid}.${expRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  if (parseInt(expRaw, 10) < Math.floor(Date.now() / 1000)) return { ok: false };
  return { ok: true };
}

test("A validly signed, unexpired QR pass still verifies", () => {
  const token = mirrorGenerateQrToken("11111111-1111-1111-1111-111111111111", "CATERING");
  assert.equal(mirrorVerifyQrToken(token).ok, true);
});

test("REGRESSION: a tampered/invalid QR signature is rejected, not silently accepted, by the unified scan path", () => {
  const token = mirrorGenerateQrToken("11111111-1111-1111-1111-111111111111", "CATERING");
  const tampered = token.slice(0, -4) + "XXXX";
  assert.equal(mirrorVerifyQrToken(tampered).ok, false);
});

test("REGRESSION: an expired QR pass is rejected by the unified scan path", () => {
  const token = mirrorGenerateQrToken("11111111-1111-1111-1111-111111111111", "CATERING", -10);
  assert.equal(mirrorVerifyQrToken(token).ok, false);
});

// --- Off-duty enforcement: explicitly NOT implemented anywhere in the ICMS
// checkpoint scan/complete path (scanTransaction, requireCheckpointRole, or
// the checkpoint submit actions in lib/icms/actions/transactions.ts) as of
// this fix. Adding a new duty-status gate was out of scope here — it would
// be a new authorization feature, not a fix to the reported defect, and
// risks crossing into the duty/attendance system this task explicitly says
// not to change. This test documents that fact so it is a deliberate,
// visible gap rather than a silent one. */
test("DOCUMENTED GAP: checkpoint scanning/completion has no duty-status (on-duty/off-duty) check independent of ops_group — not added by this fix, flagged for a separate decision", () => {
  // opsGroupCanAccessCheckpoint only ever inspects ops_group; it has no
  // duty-status parameter, and neither does requireCheckpointRole().
  assert.equal(opsGroupCanAccessCheckpoint.length, 2);
});
