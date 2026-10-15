import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleWoisDocument, resolveWoisDocument, WOIS_DOCUMENTS } from "../lib/wois/documents.ts";

/**
 * The WOIS source PDF is the internal knowledge source. It may be served only to the callers WOIS chat/history serve (approved profile
 * with an active Malaysia-AOC assignment, decided in the database by is_wois_eligible_secure()), only from a fixed allowlist, and never
 * with a request-controlled path.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wois-docs-"));
fs.writeFileSync(path.join(root, "W_O_I_S.pdf"), Buffer.from("%PDF-1.4 test"));
fs.writeFileSync(path.join(root, "secret.txt"), "not a document");
const outside = path.join(path.dirname(root), "wois-outside.pdf");
fs.writeFileSync(outside, "%PDF outside");

type Elig = { eligible: boolean; reason?: string };
const call = (id: string, elig: Elig, extra: Partial<Parameters<typeof handleWoisDocument>[1]> = {}) =>
  handleWoisDocument(id, { eligibility: async () => elig as never, root, ...extra });
const ELIGIBLE: Elig = { eligible: true };

test("the allowlist contains exactly the WOIS source document", () => {
  assert.deepEqual(Object.keys(WOIS_DOCUMENTS), ["W_O_I_S"]);
});

test("anonymous callers are refused (401) and receive no document", async () => {
  const r = await call("W_O_I_S.pdf", { eligible: false, reason: "unauthenticated" });
  assert.equal(r.status, 401);
  assert.equal((await r.text()).includes("%PDF"), false);
});

test("approved Malaysia-AOC callers receive the PDF as a private attachment", async () => {
  const r = await call("W_O_I_S.pdf", ELIGIBLE);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="W_O_I_S.pdf"');
  assert.equal(r.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "%PDF-1.4 test");
  // the id without the extension is the same document
  assert.equal((await call("W_O_I_S", ELIGIBLE)).status, 200);
});

test("foreign-AOC, pending, rejected, deactivated, revoked, expired and future-assignment callers are refused (403): the database says not eligible", async () => {
  for (const who of ["foreign AOC", "pending", "rejected", "deactivated", "revoked", "expired", "future"]) {
    const r = await call("W_O_I_S.pdf", { eligible: false, reason: "not_eligible" });
    assert.equal(r.status, 403, who);
    assert.deepEqual(await r.json(), { error: "Not available." }, who);
  }
});

test("a failed eligibility check fails closed with a generic error", async () => {
  const r = await call("W_O_I_S.pdf", { eligible: false, reason: "authorization_check_failed" });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "Not available." });
  const t = await handleWoisDocument("W_O_I_S.pdf", { eligibility: async () => { throw new Error(`boom ${root}`); }, root });
  assert.equal(t.status, 503);
  assert.equal((await t.text()).includes(root), false);
});

test("the authorization decision comes before any file system access", async () => {
  let touched = false;
  const r = await handleWoisDocument("W_O_I_S.pdf", { eligibility: async () => ({ eligible: false, reason: "not_eligible" }) as never, root, read: async () => { touched = true; return Buffer.from("x"); } });
  assert.equal(r.status, 403);
  assert.equal(touched, false);
});

test("unknown ids are 404 for eligible callers and never reach the file system", async () => {
  let touched = false;
  for (const id of ["nope", "secret", "secret.txt", "W_O_I_S.PDF", "w_o_i_s", ""]) {
    const r = await call(id, ELIGIBLE, { read: async () => { touched = true; return Buffer.from("x"); } });
    assert.equal(r.status, 404, JSON.stringify(id));
  }
  assert.equal(touched, false);
});

test("traversal attempts (slash, encoded slash, backslash, dot-dot, absolute, null byte) are refused without touching the file system", async () => {
  let touched = false;
  const attempts = ["../secret.txt", "..%2fsecret.txt", "..%2Fsecret", "..\\secret", "..%5csecret", "%2e%2e/secret", "....//secret", "/etc/passwd", "C:\\Windows\\win.ini", "W_O_I_S.pdf/../secret.txt", "W_O_I_S.pdf\0.txt", "../wois-outside.pdf", "..", "."];
  for (const id of attempts) {
    const r = await call(id, ELIGIBLE, { read: async () => { touched = true; return Buffer.from("x"); } });
    assert.equal(r.status, 404, JSON.stringify(id));
    const body = await r.text();
    assert.equal(body.includes(root), false, "no path disclosure");
  }
  assert.equal(touched, false);
});

test("resolveWoisDocument returns only allowlisted files that stay inside the private directory", () => {
  assert.equal(resolveWoisDocument("W_O_I_S.pdf", root)?.path, path.join(root, "W_O_I_S.pdf"));
  assert.equal(resolveWoisDocument("../wois-outside.pdf", root), null);
  assert.equal(resolveWoisDocument("secret.txt", root), null);
});

test("defence in depth: an allowlisted name that resolves outside the directory (symlink) is refused", () => {
  const link = path.join(root, "linked.pdf");
  try { fs.symlinkSync(outside, link); } catch { return; } // symlinks need privileges on some Windows setups
  const patched = { ...WOIS_DOCUMENTS } as Record<string, { file: string; filename: string }>;
  patched["linked"] = { file: "linked.pdf", filename: "linked.pdf" };
  assert.equal(resolveWoisDocument("linked", root, patched), null);
});

test("internal read failures return a generic 500 with no path or message", async () => {
  const r = await call("W_O_I_S.pdf", ELIGIBLE, { read: async () => { throw new Error(`ENOENT: no such file ${root}\\W_O_I_S.pdf`); } });
  assert.equal(r.status, 500);
  const body = await r.text();
  assert.deepEqual(JSON.parse(body), { error: "Document unavailable." });
  assert.equal(body.includes("ENOENT"), false);
  assert.equal(body.includes(root), false);
});

test("the source is no longer in a public path, and the route is wired to the handler", () => {
  assert.equal(fs.existsSync("public/docs/W_O_I_S.pdf"), false, "the PDF must not be a public static asset");
  assert.ok(fs.existsSync("private/wois/W_O_I_S.pdf"), "the PDF lives in the private directory");
  const route = fs.readFileSync("app/api/wois/documents/[id]/route.ts", "utf8");
  assert.match(route, /handleWoisDocument/);
  assert.doesNotMatch(route, /path\.join|readFileSync|process\.cwd/, "the route builds no path itself");
  assert.match(fs.readFileSync("next.config.ts", "utf8"), /private\/wois/, "the private file is traced into the serverless bundle");
});
