import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { vendorSignaturePath, uploadVendorCheckSignature, discardVendorSignature, reconcileVendorSignatureOrphans, VENDOR_SIGNATURE_PATH_RE } from "../lib/icms/vendor-signature.ts";

const DELIVERY = "11111111-2222-4333-8444-555555555555";
const PNG = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");

function deps(over: Record<string, unknown> = {}) {
  const calls = { upload: [] as { path: string; type: string; size: number }[], removed: [] as string[][], logs: [] as string[] };
  let n = 0;
  const d = {
    upload: async (path: string, bytes: Uint8Array, type: string) => { calls.upload.push({ path, type, size: bytes.byteLength }); return { error: null }; },
    removeAsService: async (paths: string[]) => { calls.removed.push(paths); return { error: null }; },
    isReferenced: async () => false as boolean | null,
    listOrphans: async () => [] as string[],
    log: (e: string) => { calls.logs.push(e); },
    randomId: () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, "0")}`,
    ...over,
  };
  return { d: d as never, calls };
}

test("the storage path is derived on the server from the delivery id and a random id, never from the browser", () => {
  const p = vendorSignaturePath(DELIVERY, "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", "png");
  assert.equal(p, `vendor-part-b/${DELIVERY}/aaaaaaaa-bbbb-4ccc-8ddd-000000000001.png`);
  assert.match(p, VENDOR_SIGNATURE_PATH_RE);
  for (const bad of ["../x.png", "vendor-part-b/../../x.png", `vendor-part-b/${DELIVERY}/../x.png`, "part-b/x.png", `vendor-part-b/${DELIVERY}/x.exe`, `vendor-part-b/not-a-uuid/aaaaaaaa-bbbb-4ccc-8ddd-000000000001.png`]) assert.doesNotMatch(bad, VENDOR_SIGNATURE_PATH_RE, bad);
  assert.throws(() => vendorSignaturePath("../evil", "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", "png"));
  assert.throws(() => vendorSignaturePath(DELIVERY, "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", "exe" as never));
});

test("a valid signature is uploaded once to the derived path with its content hash", async () => {
  const { d, calls } = deps();
  const r = await uploadVendorCheckSignature(DELIVERY, PNG, d);
  assert.equal(calls.upload.length, 1);
  assert.equal(r.path, calls.upload[0].path);
  assert.match(r.path, VENDOR_SIGNATURE_PATH_RE);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(calls.upload[0].type, "image/png");
});

test("malformed or oversized image data and a malformed delivery id never reach Storage", async () => {
  const { d, calls } = deps();
  for (const bad of ["not-a-data-url", "data:text/html;base64,PGgxPg==", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,"]) {
    await assert.rejects(() => uploadVendorCheckSignature(DELIVERY, bad, d), /Invalid image data/);
  }
  const big = "data:image/png;base64," + Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(() => uploadVendorCheckSignature(DELIVERY, big, d), /5MB/);
  await assert.rejects(() => uploadVendorCheckSignature("../../evil", PNG, d), /delivery/i);
  assert.equal(calls.upload.length, 0);
});

test("an upload the database refused (unauthorized caller) surfaces a generic error and leaves nothing to clean", async () => {
  const { d, calls } = deps({ upload: async () => ({ error: { message: 'new row violates row-level security policy for table "objects"' } }) });
  await assert.rejects(() => uploadVendorCheckSignature(DELIVERY, PNG, d), (e: Error) => /could not be uploaded/i.test(e.message) && !/row-level|objects|policy/i.test(e.message));
  assert.equal(calls.removed.length, 0);
});

test("after a database refusal the uploaded object is removed, but only when no checkpoint references it", async () => {
  const path = vendorSignaturePath(DELIVERY, "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", "png");
  const a = deps();
  assert.equal(await discardVendorSignature(path, a.d), "removed");
  assert.deepEqual(a.calls.removed, [[path]]);
  const b = deps({ isReferenced: async () => true });
  assert.equal(await discardVendorSignature(path, b.d), "kept");
  assert.equal(b.calls.removed.length, 0);
  const c = deps({ isReferenced: async () => null });
  assert.equal(await discardVendorSignature(path, c.d), "failed", "an unknown reference state is never deleted");
  assert.equal(c.calls.removed.length, 0);
  assert.ok(c.calls.logs.includes("vendor_signature_orphan"));
});

test("a failed removal is logged as an orphan for durable reconciliation and never thrown", async () => {
  const path = vendorSignaturePath(DELIVERY, "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", "png");
  const { d, calls } = deps({ removeAsService: async () => ({ error: { message: "storage down" } }) });
  assert.equal(await discardVendorSignature(path, d), "failed");
  assert.ok(calls.logs.includes("vendor_signature_orphan"));
  const throwing = deps({ removeAsService: async () => { throw new Error("boom"); } });
  assert.equal(await discardVendorSignature(path, throwing.d), "failed");
  assert.equal(await discardVendorSignature("../../etc/passwd", deps().d), "failed", "a path outside the vendor pattern is never removed");
});

test("a retry after a failure uploads to a NEW path (the earlier object was discarded)", async () => {
  const { d, calls } = deps();
  const first = await uploadVendorCheckSignature(DELIVERY, PNG, d);
  await discardVendorSignature(first.path, d);
  const second = await uploadVendorCheckSignature(DELIVERY, PNG, d);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(calls.removed, [[first.path]]);
});

test("reconciliation removes only listed, pattern-valid, unreferenced vendor signatures", async () => {
  const good = vendorSignaturePath(DELIVERY, "aaaaaaaa-bbbb-4ccc-8ddd-000000000009", "png");
  const { d, calls } = deps({ listOrphans: async () => [good, "../../escape.png", "part-b/other.png", `vendor-part-b/${DELIVERY}/zzz.png`] });
  const r = await reconcileVendorSignatureOrphans(d, 30);
  assert.deepEqual(calls.removed, [[good]]);
  assert.equal(r.removed, 1);
  assert.equal(r.skipped, 3);
});

test("source: the action uses the delivery-bound upload, cleans up on a refused save, and reads no path from the browser", () => {
  const src = fs.readFileSync("lib/icms/actions/vendor-transactions.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function submitVendorPartB("), src.indexOf("export async function submitVendorPartC("));
  assert.match(fn, /uploadVendorCheckSignature\(deliveryId/);
  assert.doesNotMatch(fn, /uploadDataUrl\(/);
  assert.match(fn, /discardVendorSignature\(/);
  assert.doesNotMatch(fn, /str\(formData, "(signature_url|signature_path|bucket|path)"\)/);
});

test("reconciliation survives a failing orphan listing (reported, never thrown)", async () => {
  const { d, calls } = deps({ listOrphans: async () => { throw new Error("rpc down"); } });
  const r = await reconcileVendorSignatureOrphans(d, 30);
  assert.deepEqual(r, { removed: 0, skipped: 0, failed: true });
  assert.ok(calls.logs.includes("vendor_signature_reconcile_list_failed"));
});

test("source: the action also discards the object when the finalize RPC THROWS, not only when it returns an error", () => {
  const src = fs.readFileSync("lib/icms/actions/vendor-transactions.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function submitVendorPartB("), src.indexOf("export async function submitVendorPartC("));
  assert.match(fn, /try \{[\s\S]*callCaterlinkRpc\(supabase, "record_caterlink_vendor_security_check_secure"[\s\S]*\} catch/);
  assert.match(fn, /\} catch \(e\) \{\s*error = \{/, "a thrown RPC is converted into the same failure path");
  assert.match(fn, /if \(error\) \{[\s\S]*?await discardVendorSignature\(sig\.path, sigDeps\)/, "one discard serves both the returned and the thrown failure");
});

test("source: a CRON_SECRET-protected route runs durable reconciliation and fails closed without the secret", () => {
  const src = fs.readFileSync("app/api/icms/vendor-signature-reconcile/route.ts", "utf8");
  assert.match(src, /reconcileVendorSignatureOrphans\(/);
  assert.match(src, /process\.env\.CRON_SECRET/);
  assert.match(src, /if \(!secret[\s\S]{0,80}\) return[\s\S]{0,120}(401|403|503)/);
  assert.match(src, /timingSafeEqual/);
  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  assert.ok((vercel.crons ?? []).some((c: { path: string }) => c.path === "/api/icms/vendor-signature-reconcile"));
});
