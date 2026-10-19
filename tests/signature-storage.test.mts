import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SIGNATURE_PATH_RE, SIGNATURE_KINDS, signaturePath, uploadSignature, discardSignature, reconcileSignatureOrphans, settleSignature, captureOutcome, isAmbiguousTransportError,
} from "../lib/icms/signature-storage.ts";

const U1 = "11111111-2222-4333-8444-555555555555";
const U2 = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const PNG = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");

function deps(over: Record<string, unknown> = {}) {
  const calls = { upload: [] as { path: string; type: string }[], removed: [] as string[][], logs: [] as string[] };
  let n = 0;
  const d = {
    upload: async (path: string, _b: Uint8Array, type: string) => { calls.upload.push({ path, type }); return { error: null }; },
    removeAsService: async (paths: string[]) => { calls.removed.push(paths); return { error: null }; },
    isReferenced: async () => false as boolean | null,
    listOrphans: async () => [] as string[],
    log: (e: string) => { calls.logs.push(e); },
    randomId: () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, "0")}`,
    ...over,
  };
  return { d: d as never, calls };
}

test("every approved kind derives a server-side path in its documented format", () => {
  assert.deepEqual([...SIGNATURE_KINDS].sort(), ["part-a", "part-b", "receipt", "vendor-part-b", "vendor-part-c", "vendor-signatures"]);
  assert.equal(signaturePath("part-a", U1, U2, "png"), `part-a/${U1}/${U2}.png`);
  assert.equal(signaturePath("vendor-signatures", U1, U2, "webp"), `vendor-signatures/${U1}/${U2}.webp`);
  assert.equal(signaturePath("part-b", U1, U2, "jpg"), `part-b/${U1}-${U2}.jpg`);
  assert.equal(signaturePath("receipt", U1, U2, "png"), `receipt/${U1}/${U2}.png`);
  assert.equal(signaturePath("vendor-part-b", U1, U2, "png"), `vendor-part-b/${U1}/${U2}.png`);
  assert.equal(signaturePath("vendor-part-c", U1, U2, "png"), `vendor-part-c/${U1}/${U2}.png`);
});

test("a malformed or hostile scope id, random id or extension never produces a path", () => {
  for (const bad of ["../evil", "", "not-a-uuid", `${U1}/x`, U2.toUpperCase(), `${U1}\n`]) {
    assert.throws(() => signaturePath("part-a", bad, U2, "png"), undefined, bad);
    assert.throws(() => signaturePath("receipt", U1, bad, "png"), undefined, bad);
  }
  assert.throws(() => signaturePath("part-a", U1, U2, "exe" as never));
  assert.throws(() => signaturePath("part-a", U1, U2, "PNG" as never));
  assert.throws(() => signaturePath("unknown" as never, U1, U2, "png"));
});

test("the path pattern accepts only the six documented shapes", () => {
  for (const ok of [`part-a/${U1}/${U2}.png`, `part-b/${U1}-${U2}.jpg`, `receipt/${U1}/${U2}.webp`, `vendor-signatures/${U1}/${U2}.png`, `vendor-part-b/${U1}/${U2}.png`, `vendor-part-c/${U1}/${U2}.png`]) {
    assert.ok(SIGNATURE_PATH_RE.test(ok), ok);
  }
  for (const bad of [
    "arbitrary-test/x.png", `e2e-probe/driver-1.png`, "part-a/1700000000000-abcd1234.png", `part-a/${U1}/${U2}.PNG`, `part-a/${U1}/${U2}.gif`,
    `part-a/${U1}//${U2}.png`, `part-a/${U1}/../${U2}.png`, `/part-a/${U1}/${U2}.png`, `part-a/${U1}/${U2}.png/`, `part-b/${U1}/${U2}.png`, `receipt/${U1}-${U2}.png`,
    `part-a/${U1}/${U2}.png\n`, `signatures/part-a/${U1}/${U2}.png`,
  ]) assert.ok(!SIGNATURE_PATH_RE.test(bad), JSON.stringify(bad));
});

test("upload derives the path on the server, uploads once with the caller's session and returns the content hash", async () => {
  const { d, calls } = deps();
  const r = await uploadSignature("receipt", U1, PNG, d);
  assert.match(r.path, new RegExp(`^receipt/${U1}/aaaaaaaa-bbbb-4ccc-8ddd-000000000001\\.png$`));
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].path, r.path);
  assert.equal(calls.upload[0].type, "image/png");
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test("invalid image data, oversize and a refused upload never reach Storage or leak internals", async () => {
  const a = deps();
  await assert.rejects(uploadSignature("part-a", U1, "data:text/html;base64,AAAA", a.d), /Invalid image data/);
  await assert.rejects(uploadSignature("part-a", U1, "data:image/png;base64,", a.d), /Invalid image data/);
  await assert.rejects(uploadSignature("part-a", U1, "data:image/png;base64," + Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"), a.d), /5MB/);
  assert.equal(a.calls.upload.length, 0);
  const b = deps({ upload: async () => ({ error: { message: "new row violates row-level security policy for table objects" } }) });
  await assert.rejects(uploadSignature("part-a", U1, PNG, b.d), (e: Error) => e.message === "The signature could not be uploaded." && !/row-level|policy|objects/i.test(e.message));
  assert.ok(b.calls.logs.includes("signature_upload_refused"));
});

test("discard removes only an unreferenced object of an approved shape, and never on an unknown reference state", async () => {
  const path = `part-b/${U1}-${U2}.png`;
  const a = deps();
  assert.equal(await discardSignature(path, a.d), "removed");
  assert.deepEqual(a.calls.removed, [[path]]);
  const b = deps({ isReferenced: async () => true });
  assert.equal(await discardSignature(path, b.d), "kept");
  assert.deepEqual(b.calls.removed, []);
  const c = deps({ isReferenced: async () => null });
  assert.equal(await discardSignature(path, c.d), "failed");
  assert.deepEqual(c.calls.removed, []);
  const e = deps();
  assert.equal(await discardSignature("../../etc/passwd", e.d), "failed");
  assert.equal(await discardSignature("arbitrary-test/x.png", e.d), "failed");
  assert.deepEqual(e.calls.removed, []);
  const t = deps({ removeAsService: async () => { throw new Error("boom"); } });
  assert.equal(await discardSignature(path, t.d), "failed");
});

test("settle discards after a RETURNED refusal but keeps the object after a thrown (ambiguous) failure", async () => {
  const path = `part-a/${U1}/${U2}.png`;
  const refused = deps();
  assert.equal(await settleSignature(path, refused.d, { error: { message: "no" }, thrown: false }), "removed");
  assert.deepEqual(refused.calls.removed, [[path]]);
  const thrown = deps();
  assert.equal(await settleSignature(path, thrown.d, { error: { message: "timeout" }, thrown: true }), "kept-for-reconciliation");
  assert.deepEqual(thrown.calls.removed, []);
  const ok = deps({ isReferenced: async () => true });
  assert.equal(await settleSignature(path, ok.d, { error: null, thrown: false }), "recorded");
  assert.deepEqual(ok.calls.removed, []);
  // a "successful" call that did NOT reference the object (e.g. an ON CONFLICT retry) leaves an orphan: it is removed now
  const unref = deps({ isReferenced: async () => false });
  assert.equal(await settleSignature(path, unref.d, { error: null, thrown: false }), "removed");
  assert.deepEqual(unref.calls.removed, [[path]]);
  // an unknown reference state after success is never a reason to delete
  const unknown = deps({ isReferenced: async () => null });
  assert.equal(await settleSignature(path, unknown.d, { error: null, thrown: false }), "failed");
  assert.deepEqual(unknown.calls.removed, []);
});

test("reconciliation lists every approved prefix, re-checks each reference and survives a failing listing", async () => {
  const names = [`part-a/${U1}/${U2}.png`, `part-b/${U1}-${U2}.png`, `receipt/${U1}/${U2}.png`, `vendor-part-c/${U1}/${U2}.png`, "arbitrary-test/x.png", `part-a/${U1}/${U2}.PNG`];
  const raced = names[1];
  const { d, calls } = deps({ listOrphans: async () => names, isReferenced: async (p: string) => p === raced });
  const r = await reconcileSignatureOrphans(d, 30);
  assert.deepEqual(calls.removed, [[names[0], names[2], names[3]]]);
  assert.equal(r.removed, 3);
  assert.equal(r.skipped, 3);
  const bad = deps({ listOrphans: async () => { throw new Error("rpc down"); } });
  { const br = await reconcileSignatureOrphans(bad.d, 30); assert.deepEqual([br.removed, br.skipped, br.failed], [0, 0, true]); }
});

test("source: no application code uploads to the signatures bucket by a client-chosen name any more", () => {
  const storage = fs.readFileSync("lib/icms/storage.ts", "utf8");
  const header = storage.slice(storage.indexOf("export async function uploadDataUrl("), storage.indexOf("export async function signedUrl("));
  assert.doesNotMatch(header.slice(0, header.indexOf("): Promise<UploadResult>")), /"signatures"/, "uploadDataUrl no longer accepts the signatures bucket in its type");
  assert.match(storage, /\(bucket as string\) === "signatures"\) throw/, "a runtime guard refuses the signatures bucket");
  for (const f of ["lib/icms/actions/transactions.ts", "lib/icms/actions/vendor-transactions.ts", "lib/avsec/caterlink/receipt.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /uploadDataUrl\("signatures"/, f);
    assert.match(src, /uploadSignature\(/, f);
    assert.doesNotMatch(src, /str\(formData, "(signature_url|signature_path|bucket|path)"\)/, f);
  }
});

test("source: each workflow uploads with its own kind and bound scope", () => {
  const tx = fs.readFileSync("lib/icms/actions/transactions.ts", "utf8");
  assert.match(tx, /uploadSignature\("part-a", profile\.id,/);
  assert.match(tx, /uploadSignature\("part-b", transactionId,/);
  const v = fs.readFileSync("lib/icms/actions/vendor-transactions.ts", "utf8");
  assert.match(v, /uploadSignature\("vendor-signatures", /);
  assert.match(v, /uploadSignature\("vendor-part-b", deliveryId,/);
  assert.match(v, /uploadSignature\("vendor-part-c", deliveryId,/);
  const r = fs.readFileSync("lib/avsec/caterlink/receipt.ts", "utf8");
  assert.match(r, /uploadSignature\("receipt", transactionId,/);
});

test("source: every upload action settles its object after the database call (discard on refusal, keep on thrown failure)", () => {
  for (const f of ["lib/icms/actions/transactions.ts", "lib/icms/actions/vendor-transactions.ts", "lib/avsec/caterlink/receipt.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    const uploads = (src.match(/uploadSignature\(/g) ?? []).length;
    const settles = (src.match(/settleSignature\(/g) ?? []).length;
    assert.ok(settles >= uploads, `${f}: ${uploads} upload(s) but ${settles} settle call(s)`);
  }
});

test("source: the scheduled reconciliation covers every approved prefix and still fails closed", () => {
  const src = fs.readFileSync("app/api/icms/vendor-signature-reconcile/route.ts", "utf8");
  assert.match(src, /reconcileSignatureOrphans\(/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /if \(!secret\) return/);
});

test("documentation: the inventory names every approved prefix and the staging counts are present without record contents", () => {
  const doc = fs.readFileSync("docs/dashboard-review/signature-bucket-authorization.md", "utf8");
  for (const prefix of SIGNATURE_KINDS) assert.ok(doc.includes("`" + prefix + "/") || doc.includes(prefix + "/"), `the document names ${prefix}`);
  assert.match(doc, /signatures: authenticated upload/);
  assert.match(doc, /\*\*Total\*\* \| \*\*29\*\*/);
  assert.match(doc, /incident-photos/, "the sibling bucket limitation is stated");
  assert.doesNotMatch(doc, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "no identifier from staging appears");
});

test("migration: the single INSERT policy replaces the broad one and nothing grants a generic authenticated upload", () => {
  const sql = fs.readFileSync("supabase/migrations/20261113000001_signature_upload_authorization.sql", "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /drop policy if exists "signatures: authenticated upload" on storage\.objects/);
  assert.match(sql, /create policy "signatures: workflow upload" on storage\.objects\s+for insert to authenticated/);
  assert.match(sql, /owner = auth\.uid\(\)/);
  assert.match(sql, /caterlink_signature_upload_allowed\(name\)/);
  assert.doesNotMatch(sql, /auth\.role\(\)/, "no auth.role() check");
  assert.doesNotMatch(sql, /user_metadata|raw_user_meta_data|app_metadata/i, "no metadata-based authorization");
  assert.doesNotMatch(sql, /with check\s*\(\s*(true|bucket_id = 'signatures'\s*\))/i, "no generic upload fallback");
  const defs = sql.match(/create or replace function public\.\w+\([^)]*\)[\s\S]*?\$function\$;/g) ?? [];
  assert.ok(defs.length >= 7, "all helpers are defined");
  for (const d of defs) {
    assert.match(d, /set search_path to 'public'/, d.slice(0, 80));
    assert.match(d, /security definer/i);
  }
  assert.ok(!/grant execute on function public\.(caterlink_signature_referenced|list_orphan_signatures_secure)[^;]*to[^;]*(authenticated|anon|public)/i.test(sql), "reference check and orphan listing are service-role only");
});

test("a transport failure returned as an error object (status 0 / no SQLSTATE) is ambiguous exactly like a throw; a database refusal is not", async () => {
  const fetchFailure = await captureOutcome(async () => ({ error: { message: "FetchError: network request failed" }, status: 0 }));
  assert.equal(fetchFailure.thrown, true);
  const timeout = await captureOutcome(async () => ({ error: { message: "The operation was aborted due to timeout" }, status: 0 }));
  assert.equal(timeout.thrown, true);
  const refusal = await captureOutcome(async () => ({ error: { message: "Not authorised", code: "P0001" }, status: 400 }));
  assert.equal(refusal.thrown, false);
  const rls = await captureOutcome(async () => ({ error: { message: "new row violates row-level security policy", code: "42501" }, status: 403 }));
  assert.equal(rls.thrown, false);
  const ok = await captureOutcome(async () => ({ error: null, status: 200 }));
  assert.deepEqual([ok.thrown, ok.error], [false, null]);
  const thrownOutcome = await captureOutcome(async () => { throw new Error("boom"); });
  assert.equal(thrownOutcome.thrown, true);
  assert.equal(isAmbiguousTransportError(null), false);
  assert.equal(isAmbiguousTransportError({ message: "x", code: "23505" }, 0), false);
});

test("an ambiguous outcome keeps the object for reconciliation; a database refusal discards it", async () => {
  const path = `part-b/${U1}-${U2}.png`;
  const ambiguous = await captureOutcome(async () => ({ error: { message: "FetchError: socket hang up" }, status: 0 }));
  const a = deps();
  assert.equal(await settleSignature(path, a.d, ambiguous), "kept-for-reconciliation");
  assert.deepEqual(a.calls.removed, []);
  const refused = await captureOutcome(async () => ({ error: { message: "Out of order", code: "P0001" }, status: 400 }));
  const b = deps();
  assert.equal(await settleSignature(path, b.d, refused), "removed");
  assert.deepEqual(b.calls.removed, [[path]]);
});

test("a gateway failure (5xx without a SQLSTATE) is ambiguous; a database verdict with a SQLSTATE is not, whatever the status", async () => {
  for (const status of [502, 503, 504, 520, 0]) {
    assert.equal(isAmbiguousTransportError({ message: "The upstream server is timing out" }, status), true, String(status));
    assert.equal(isAmbiguousTransportError({ message: "Bad gateway" }, status), true, String(status));
  }
  assert.equal(isAmbiguousTransportError({ message: "Not authorised", code: "P0001" }, 500), false, "a SQLSTATE means the database answered");
  assert.equal(isAmbiguousTransportError({ message: "Not authorised" }, 400), false, "a 4xx without a SQLSTATE and without a transport message is a refusal");
  const gw = await captureOutcome(async () => ({ error: { message: "Gateway Time-out" }, status: 504 }));
  assert.equal(gw.thrown, true);
  const keep = deps();
  assert.equal(await settleSignature(`part-a/${U1}/${U2}.png`, keep.d, gw), "kept-for-reconciliation");
  assert.deepEqual(keep.calls.removed, []);
});

test("reconciliation pages through the backlog, advancing past rows that could not be removed, and stops at the page cap", async () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => `part-a/${U1}/aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, "0")}.png`);
  // a stateful fake of the server: removed names leave the listing; the first 200 names cannot be removed (a stuck head)
  const make = (total: number, stuck: number) => {
    const live = new Set(mk(total));
    const stuckNames = new Set(mk(total).slice(0, stuck));
    const asked: number[] = [];
    return {
      asked,
      live,
      d: deps({
        listOrphans: async (_m: number, offset: number) => { asked.push(offset); return [...live].sort().slice(offset, offset + 200); },
        removeAsService: async (paths: string[]) => { if (paths.some((x) => stuckNames.has(x))) { for (const x of paths) if (!stuckNames.has(x)) live.delete(x); return { error: { message: "partial failure" } }; } for (const x of paths) live.delete(x); return { error: null }; },
      }).d,
    };
  };
  const f = make(450, 200);
  const r = await reconcileSignatureOrphans(f.d, 30);
  assert.equal(f.live.size, 200, "only the stuck head remains; everything behind it was reached");
  assert.equal(r.removed + r.skipped >= 450, true);
  assert.ok(f.asked.includes(200), "the offset advanced past the stuck head");
  const endless = deps({ listOrphans: async () => mk(200), removeAsService: async () => ({ error: { message: "down" } }) });
  const cap = await reconcileSignatureOrphans(endless.d, 30, 3);
  assert.equal(cap.removed, 0);
  assert.equal(cap.pages, 3, "a stuck backlog cannot loop forever");
});
