import { createHash } from "node:crypto";

/**
 * Vendor Part B signature storage workflow.
 *
 * Root cause of the defect this fixes: the signature used to be uploaded to the shared `signatures` bucket under a client-chosen name
 * BEFORE the database authorised the checkpoint, the storage policy let ANY signed-in user write there, and nothing removed the object
 * when the save was refused. An unauthorised or rejected request therefore left a permanent object.
 *
 * Workflow now:
 *  1. The path is derived on the server: vendor-part-b/<delivery id>/<random id>.<ext>. The browser supplies no bucket, path or name.
 *  2. A restrictive Storage policy (migration 20261111000001) lets a caller write under vendor-part-b/<delivery id>/ only if the DATABASE says
 *     they may security-check that delivery right now (approved, assigned to its station, capability on, delivery still CREATED).
 *  3. record_caterlink_vendor_security_check_secure() accepts only a path bound to that delivery, for an object the caller owns, and its
 *     row lock/state check makes the checkpoint single-shot.
 *  4. If the save is refused or fails, discardVendorSignature() removes exactly that object (service role, only when no checkpoint
 *     references it); a failed removal is logged and the object is found later by list_orphan_vendor_signatures_secure() and removed by
 *     reconcileVendorSignatureOrphans().
 * Downloads are unchanged: caterlink_signature_visible() authorises them through the checkpoint row that references the path. The bucket stays private.
 */
// the same shape the database policy, finalize RPC and orphan listing accept (any lowercase hex UUID), so nothing the database lists is unremovable here
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const VENDOR_SIGNATURE_PATH_RE = new RegExp(`^vendor-part-b/${UUID}/${UUID}\\.(png|jpg|webp)$`);
const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

export interface VendorSignatureDeps {
  /** Upload with the CALLER's own session so Storage RLS (the delivery-bound policy) decides. */
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: { message?: string } | null }>;
  /** Service-role removal of exact object paths. */
  removeAsService: (paths: string[]) => Promise<{ error: { message?: string } | null }>;
  /** Whether a vendor checkpoint references the path (service role). null = unknown. */
  isReferenced: (path: string) => Promise<boolean | null>;
  /** Orphan candidates older than N minutes (service role RPC). */
  listOrphans: (olderThanMinutes: number) => Promise<string[]>;
  log: (event: string, detail?: Record<string, string | number>) => void;
  randomId: () => string;
}

export function vendorSignaturePath(deliveryId: string, randomId: string, ext: "png" | "jpg" | "webp"): string {
  const path = `vendor-part-b/${deliveryId}/${randomId}.${ext}`;
  if (!VENDOR_SIGNATURE_PATH_RE.test(path)) throw new Error("Invalid delivery reference for the signature.");
  return path;
}

export async function uploadVendorCheckSignature(deliveryId: string, dataUrl: string, deps: VendorSignatureDeps): Promise<{ path: string; sha256: string }> {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid image data");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength === 0) throw new Error("Invalid image data");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Image exceeds 5MB limit");
  const path = vendorSignaturePath(deliveryId, deps.randomId(), EXT[match[1] as keyof typeof EXT]);
  const { error } = await deps.upload(path, bytes, match[1]);
  if (error) {
    deps.log("vendor_signature_upload_refused");
    throw new Error("The signature could not be uploaded.");
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Removes the object this request just uploaded, unless a checkpoint references it. Never throws. */
export async function discardVendorSignature(path: string, deps: VendorSignatureDeps): Promise<"removed" | "kept" | "failed"> {
  if (!VENDOR_SIGNATURE_PATH_RE.test(path)) return "failed";
  try {
    const referenced = await deps.isReferenced(path);
    if (referenced === true) return "kept";
    if (referenced === null) {
      deps.log("vendor_signature_orphan", { reason: "reference-unknown" });
      return "failed";
    }
    const { error } = await deps.removeAsService([path]);
    if (error) {
      deps.log("vendor_signature_orphan", { reason: "remove-failed" });
      return "failed";
    }
    return "removed";
  } catch {
    deps.log("vendor_signature_orphan", { reason: "remove-threw" });
    return "failed";
  }
}

/** Durable reconciliation: removes vendor signatures older than N minutes that no checkpoint references. */
export async function reconcileVendorSignatureOrphans(deps: VendorSignatureDeps, olderThanMinutes = 30): Promise<{ removed: number; skipped: number; failed?: boolean }> {
  let names: string[];
  try {
    names = await deps.listOrphans(olderThanMinutes);
  } catch {
    deps.log("vendor_signature_reconcile_list_failed");
    return { removed: 0, skipped: 0, failed: true };
  }
  const valid = names.filter((n) => VENDOR_SIGNATURE_PATH_RE.test(n));
  let removed = 0;
  // re-check every path immediately before removal: a checkpoint recorded since the listing keeps its object
  const safe: string[] = [];
  for (const n of valid) {
    try {
      if ((await deps.isReferenced(n)) === false) safe.push(n);
    } catch {
      /* unknown reference state: keep the object */
    }
  }
  if (safe.length > 0) {
    try {
      const { error } = await deps.removeAsService(safe);
      if (!error) removed = safe.length;
      else deps.log("vendor_signature_reconcile_failed");
    } catch {
      deps.log("vendor_signature_reconcile_failed");
    }
  }
  return { removed, skipped: names.length - removed };
}
