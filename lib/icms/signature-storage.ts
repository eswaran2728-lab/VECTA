import { createHash } from "node:crypto";

/**
 * Signature Storage workflow (all CaterLink signature uploads).
 *
 * The `signatures` bucket accepts an object only if the DATABASE authorises its name (migration 20261113000001): the caller, the parent
 * record, the caller's role and scope, and the workflow state are all checked at Storage RLS. Therefore:
 *  1. The path is derived here, on the server, in one of six fixed formats. The browser supplies the image only -- never a bucket, a path
 *     or a name.
 *  2. The upload runs with the CALLER's own session, so Storage RLS (and not this code) decides whether it is allowed.
 *  3. The finalising RPC/trigger accepts only that bound path, for an object the caller owns and that is fresh.
 *  4. If the database call RETURNS a refusal nothing was recorded, so settleSignature() removes exactly that object (service role, and only
 *     when no checkpoint references it). If the call THROWS (timeout, dropped connection) the outcome is ambiguous -- the transaction may
 *     still commit -- so the object is kept and the scheduled reconciliation, which re-checks the reference, decides after 30 minutes.
 *  5. Whatever is left over (a failed removal, a crash) is found by list_orphan_signatures_secure() and removed by reconcileSignatureOrphans().
 * Downloads are unchanged: caterlink_signature_visible() authorises them through the checkpoint row that references the path. The bucket is private.
 *
 *   part-a/<caller uid>/<uuid>.<ext>             Driver, before the movement exists
 *   part-b/<transaction uuid>-<uuid>.<ext>       officer recording Part B of that movement
 *   receipt/<transaction uuid>/<uuid>.<ext>      destination officer confirming receipt
 *   vendor-signatures/<caller uid>/<uuid>.<ext>  Vendor, before the delivery exists
 *   vendor-part-b/<delivery uuid>/<uuid>.<ext>   officer security-checking a delivery
 *   vendor-part-c/<delivery uuid>/<uuid>.<ext>   owning Vendor completing a security-verified delivery
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
export const SIGNATURE_KINDS = ["part-a", "part-b", "receipt", "vendor-signatures", "vendor-part-b", "vendor-part-c"] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];
type Ext = "png" | "jpg" | "webp";

export const SIGNATURE_PATH_RE = new RegExp(
  `^(?:(?:part-a|vendor-signatures|receipt|vendor-part-b|vendor-part-c)/${UUID}/${UUID}|part-b/${UUID}-${UUID})\\.(?:png|jpg|webp)$`
);
const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export interface SignatureDeps {
  /** Upload with the CALLER's own session so Storage RLS decides. */
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: { message?: string } | null }>;
  /** Service-role removal of exact object paths. */
  removeAsService: (paths: string[]) => Promise<{ error: { message?: string } | null }>;
  /** Whether any checkpoint references the path (service role). null = unknown. */
  isReferenced: (path: string) => Promise<boolean | null>;
  /** Orphan candidates older than N minutes (service role RPC). */
  listOrphans: (olderThanMinutes: number, offset: number) => Promise<string[]>;
  log: (event: string, detail?: Record<string, string | number>) => void;
  randomId: () => string;
}

export function signaturePath(kind: SignatureKind, scopeId: string, randomId: string, ext: Ext): string {
  if (!(SIGNATURE_KINDS as readonly string[]).includes(kind)) throw new Error("Unknown signature kind.");
  if (!UUID_RE.test(scopeId)) throw new Error("Invalid reference for the signature.");
  if (!UUID_RE.test(randomId)) throw new Error("Invalid signature identifier.");
  if (ext !== "png" && ext !== "jpg" && ext !== "webp") throw new Error("Invalid image type.");
  const path = kind === "part-b" ? `part-b/${scopeId}-${randomId}.${ext}` : `${kind}/${scopeId}/${randomId}.${ext}`;
  if (!SIGNATURE_PATH_RE.test(path)) throw new Error("Invalid reference for the signature.");
  return path;
}

export async function uploadSignature(kind: SignatureKind, scopeId: string, dataUrl: string, deps: SignatureDeps): Promise<{ path: string; sha256: string }> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid image data");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0) throw new Error("Invalid image data");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Image exceeds 5MB limit");
  const path = signaturePath(kind, scopeId, deps.randomId(), EXT[match[1] as keyof typeof EXT]);
  const { error } = await deps.upload(path, bytes, match[1]);
  if (error) {
    deps.log("signature_upload_refused", { kind });
    throw new Error("The signature could not be uploaded.");
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Removes the object this request just uploaded, unless a checkpoint references it. Never throws. */
export async function discardSignature(path: string, deps: SignatureDeps): Promise<"removed" | "kept" | "failed"> {
  if (!SIGNATURE_PATH_RE.test(path)) return "failed";
  try {
    const referenced = await deps.isReferenced(path);
    if (referenced === true) return "kept";
    if (referenced === null) {
      deps.log("signature_orphan", { reason: "reference-unknown" });
      return "failed";
    }
    const { error } = await deps.removeAsService([path]);
    if (error) {
      deps.log("signature_orphan", { reason: "remove-failed" });
      return "failed";
    }
    return "removed";
  } catch {
    deps.log("signature_orphan", { reason: "remove-threw" });
    return "failed";
  }
}

/**
 * After the database call: a RETURNED refusal discards the object now; a THROWN failure is ambiguous (the transaction may still commit),
 * so the object is kept for the scheduled reconciliation, which re-checks the reference before removing anything.
 */
export async function settleSignature(
  path: string,
  deps: SignatureDeps,
  outcome: { error: unknown; thrown: boolean }
): Promise<"removed" | "kept" | "failed" | "kept-for-reconciliation" | "recorded"> {
  if (!outcome.error) {
    // The call reported success, but a retry/idempotent path can succeed WITHOUT referencing this object (e.g. ON CONFLICT DO UPDATE, an
    // already-recorded checkpoint). Verify: a referenced object stays; an unreferenced one is removed; an unknown state is never deleted.
    const referenced = await deps.isReferenced(path).catch(() => null);
    if (referenced === true) return "recorded";
    if (referenced === null) {
      deps.log("signature_orphan", { reason: "reference-unknown-after-success" });
      return "failed";
    }
    return discardSignature(path, deps);
  }
  if (outcome.thrown) {
    deps.log("signature_orphan", { reason: "outcome-ambiguous" });
    return "kept-for-reconciliation";
  }
  return discardSignature(path, deps);
}

/**
 * Durable reconciliation: removes signatures older than N minutes that no checkpoint references. Pages through the backlog (200 per page,
 * at most `maxPages` pages per run); rows that could not be removed stay in the listing, so the offset advances past them and one stuck head
 * cannot starve the rest.
 */
export async function reconcileSignatureOrphans(
  deps: SignatureDeps,
  olderThanMinutes = 30,
  maxPages = 20
): Promise<{ removed: number; skipped: number; failed?: boolean; pages: number }> {
  const PAGE = 200;
  let removed = 0;
  let skipped = 0;
  let offset = 0;
  let pages = 0;
  while (pages < maxPages) {
    let names: string[];
    try {
      names = await deps.listOrphans(olderThanMinutes, offset);
    } catch {
      deps.log("signature_reconcile_list_failed");
      return { removed, skipped, failed: true, pages };
    }
    pages += 1;
    if (names.length === 0) break;
    const valid = names.filter((n) => SIGNATURE_PATH_RE.test(n));
    // re-check every path immediately before removal: a checkpoint recorded since the listing keeps its object
    const safe: string[] = [];
    for (const n of valid) {
      try {
        if ((await deps.isReferenced(n)) === false) safe.push(n);
      } catch {
        /* unknown reference state: keep the object */
      }
    }
    let pageRemoved = 0;
    if (safe.length > 0) {
      try {
        const { error } = await deps.removeAsService(safe);
        if (!error) pageRemoved = safe.length;
        else deps.log("signature_reconcile_failed");
      } catch {
        deps.log("signature_reconcile_failed");
      }
    }
    removed += pageRemoved;
    skipped += names.length - pageRemoved;
    if (names.length < PAGE) break;
    offset += names.length - pageRemoved; // removed rows left the listing; the rest are still there
  }
  return { removed, skipped, pages };
}

/** Runs the finalising database call and records whether it RETURNED a refusal or THREW, so settleSignature() can tell them apart. */
export async function captureOutcome<T extends { error: unknown }>(
  run: () => PromiseLike<T>
): Promise<{ result: T | null; error: unknown; thrown: boolean }> {
  try {
    const result = await run();
    const error = result.error ?? null;
    // PostgREST/fetch transport failures (timeout, abort, dropped connection) come back as an error object with status 0 or no SQLSTATE
    // code: the transaction may still commit, so they are ambiguous exactly like a throw. A database refusal always carries a SQLSTATE code.
    return { result, error, thrown: isAmbiguousTransportError(error, (result as { status?: number }).status) };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e : new Error("The request failed."), thrown: true };
  }
}

/** A transport-level failure (no database verdict): status 0, or an error without a SQLSTATE code whose message names a network/timeout fault. */
export function isAmbiguousTransportError(error: unknown, status?: number): boolean {
  if (!error) return false;
  const e = error as { code?: unknown; message?: unknown };
  const hasSqlState = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code);
  if (hasSqlState) return false;
  // no database verdict: status 0 (never reached the server), any 5xx (a gateway/proxy answered, the transaction may still be running or
  // committed), or a message that names a network/timeout fault
  if (status === 0 || (typeof status === "number" && status >= 500)) return true;
  return /fetch|abort|timeout|timed out|time-out|network|socket|ECONN|ETIMEDOUT|terminated|upstream|gateway/i.test(String(e.message ?? ""));
}
