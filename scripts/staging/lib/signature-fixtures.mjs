// Shared helpers for the staging scripts that exercise the signature bucket AFTER migration 20261113000001 is applied.
//
// The database authorises every signature upload (path format bound to the caller or parent record, role, scope and workflow state) and every
// checkpoint accepts only an existing, fresh, single-use object bound to its row. A script therefore must:
//   * upload each signature through the ACTOR'S OWN session, to a path in one of the six documented formats (never a fabricated name);
//   * use a FRESH object per record (an object can be referenced once);
//   * tell a genuine authorization failure (the control under test did its job) from a fixture or setup error (a bad path, a missing object,
//     a network fault) -- the second kind proves nothing and must never be counted as a pass.
// Nothing here uses the service role, so no control under test is bypassed.
import crypto from "node:crypto";

/** 1x1 PNG. */
export const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ID = () => crypto.randomUUID();

/** Documented path formats (see docs/dashboard-review/signature-bucket-authorization.md). Each call returns a NEW path. */
export const bound = {
  partA: (actorUid) => `part-a/${actorUid}/${ID()}.png`,
  partB: (transactionId) => `part-b/${transactionId}-${ID()}.png`,
  receipt: (transactionId) => `receipt/${transactionId}/${ID()}.png`,
  vendorA: (actorUid) => `vendor-signatures/${actorUid}/${ID()}.png`,
  vendorB: (deliveryId) => `vendor-part-b/${deliveryId}/${ID()}.png`,
  vendorC: (deliveryId) => `vendor-part-c/${deliveryId}/${ID()}.png`,
};

/** Raised for a fixture/setup fault: the run result is INCONCLUSIVE for that step, never a pass. */
export class SetupError extends Error {
  constructor(message) { super(message); this.name = "SetupError"; }
}

// A refusal is an authorization verdict only when it says so. Deliberately narrow: generic words ("already", "not found", "cannot be") also appear in
// fixture faults, so a control that is expected to refuse for a SPECIFIC rule must name it through `matches` (see expectAuthorizationDenied).
const AUTH_RE = /row-level security|violates row-level|not authori[sz]ed|unauthori[sz]ed|permission denied|not available (for|at|yet)|only an active|must be signed in|forbidden/i;
const SETUP_RE = /valid signature|signature object|not the one uploaded|invalid (image|path|signature|reference)|bucket not found|object not found|missing required|no (such )?(file|object)|fetch|network|timeout|timed out|abort|socket|ECONN|ENOTFOUND|JWT|sign-in|signed in|refresh token|invalid login|payload too large|mime/i;

/**
 * Classifies a Storage or RPC error: "ok" (no error), "authorization" (a database/RLS refusal), or "setup" (a fixture, path, network or
 * session fault). A message that looks like BOTH is treated as setup: a control is only credited when nothing else could explain the refusal.
 */
export function classifyError(error, httpStatus) {
  if (!error) return "ok";
  const msg = String(error.message ?? error);
  if (SETUP_RE.test(msg)) return "setup";
  const status = Number(error.statusCode ?? error.status ?? httpStatus ?? 0);
  if (status === 401 || status === 403) return "authorization";
  if (AUTH_RE.test(msg)) return "authorization";
  return "setup";
}

/**
 * Uploads `bytes` to the signatures bucket through `session.sb` (the actor's own client). Never upserts. Returns
 * { outcome: "ok" | "authorization" | "setup", error, path }.
 */
export async function uploadBound(session, path, { bucket = "signatures", bytes = PNG_BYTES } = {}) {
  const res = await session.sb.storage.from(bucket).upload(path, bytes, { contentType: "image/png", upsert: false });
  if (!res.error) createdPaths.push(path);
  return { outcome: classifyError(res.error, res.error?.statusCode), error: res.error ?? null, path };
}

/** Every object this process uploaded successfully (so a run can remove ITS OWN unreferenced leftovers and not eat the hourly upload quota of the next run). */
export const createdPaths = [];

/**
 * Removes the objects THIS run created that no checkpoint references. The reference test is the database's own (service-role RPC
 * caterlink_signature_referenced); an object whose reference state is unknown is kept. The service role is used for clean-up only, never for a verdict.
 */
export async function cleanupOwnOrphans(admin, bucket = "signatures", log = console.log) {
  const remove = [];
  for (const path of createdPaths) {
    const r = await admin.rpc("caterlink_signature_referenced", { p_name: path });
    if (!r.error && r.data === false) remove.push(path);
  }
  const rm = remove.length ? await admin.storage.from(bucket).remove(remove) : { data: [] };
  log(`clean-up: removed ${(rm.data ?? []).length} of ${createdPaths.length} object(s) this run created (the rest are referenced or of unknown state)`);
  createdPaths.length = 0;
}

/** Upload that MUST succeed (fixture creation). Throws SetupError otherwise, so a refused fixture is never mistaken for a verdict. */
export async function uploadRequired(session, path, what) {
  const r = await uploadBound(session, path);
  if (r.outcome !== "ok") throw new SetupError(`${what}: the fixture signature could not be uploaded (${r.outcome}: ${String(r.error?.message ?? "").slice(0, 100)})`);
  return path;
}

/** Tracks verdicts and setup errors separately, so the exit code can tell "a control failed" from "the run was inconclusive". */
export function createRecorder(log = console.log) {
  const state = { failures: 0, setupErrors: 0, passes: 0 };
  return {
    state,
    /** A plain boolean check (a fact, not an authorization verdict). */
    check(label, ok, note = "") { if (!ok) state.failures += 1; else state.passes += 1; log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return ok; },
    /** Passes only when the refusal is a genuine authorization refusal. A setup/fixture fault is INCONCLUSIVE, not a pass. */
    expectAuthorizationDenied(label, result, matches) {
      // `matches` names the exact refusal expected from the control under test. When given it is REQUIRED: a refusal that does not say so is
      // INCONCLUSIVE (it may be a fixture fault or a different rule), never credited as this control.
      let cls;
      if (matches) cls = result?.error && matches.test(String(result.error.message ?? "")) ? "authorization" : (result?.outcome === "ok" || !result?.error ? "ok" : "setup");
      else cls = result?.outcome ?? classifyError(result?.error, result?.status);
      if (cls === "authorization") { state.passes += 1; log(`PASS: ${label} (refused by authorization)`); return true; }
      if (cls === "setup") { state.setupErrors += 1; log(`INCONCLUSIVE: ${label} -- fixture/setup fault, not an authorization verdict: ${String(result?.error?.message ?? "").slice(0, 100)}`); return false; }
      state.failures += 1; log(`FAIL: ${label} -- the action was NOT refused`); return false;
    },
    /**
     * Two-gate actions (Storage upload, then RPC). `res` = { upload, rpc }. An unauthorised actor must be refused at BOTH gates: the Storage gate
     * (the upload) and the RPC's own check (called with a well-formed, parent-bound path that carries no object, so it is the RPC's authorization
     * that answers, not a signature fault). Each gate is credited separately, so losing either control is visible.
     */
    expectBothGatesDenied(label, res, rpcMatches) {
      const a = this.expectAuthorizationDenied(`${label} -- Storage gate`, res.upload);
      const b = res.rpc ? this.expectAuthorizationDenied(`${label} -- RPC gate`, res.rpc, rpcMatches) : (state.setupErrors += 1, log(`INCONCLUSIVE: ${label} -- RPC gate was not exercised`), false);
      return a && b;
    },
    /** Passes only when the action succeeded. A refusal is a failure; a setup fault is inconclusive. */
    expectOk(label, result) {
      const cls = result?.outcome ?? classifyError(result?.error, result?.status);
      if (cls === "ok") { state.passes += 1; log(`PASS: ${label}`); return true; }
      if (cls === "setup") { state.setupErrors += 1; log(`INCONCLUSIVE: ${label} -- fixture/setup fault: ${String(result?.error?.message ?? "").slice(0, 100)}`); return false; }
      state.failures += 1; log(`FAIL: ${label} -- unexpectedly refused: ${String(result?.error?.message ?? "").slice(0, 100)}`); return false;
    },
    /** 0 = all verdicts passed; 1 = a control failed; 2 = inconclusive (setup errors, no failed control). */
    exitCode() { return state.failures > 0 ? 1 : state.setupErrors > 0 ? 2 : 0; },
    summary() { return `verdicts: ${state.passes} pass, ${state.failures} fail, ${state.setupErrors} inconclusive (setup/fixture)`; },
  };
}
