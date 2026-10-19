import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bound, classifyError, createRecorder, uploadBound, uploadRequired, SetupError, PNG_BYTES } from "../scripts/staging/lib/signature-fixtures.mjs";
import { SIGNATURE_PATH_RE } from "../lib/icms/signature-storage.ts";

const U = "11111111-2222-4333-8444-555555555555";

test("every fixture path is one of the six documented, bound formats and is fresh each time", () => {
  const made = [bound.partA(U), bound.partB(U), bound.receipt(U), bound.vendorA(U), bound.vendorB(U), bound.vendorC(U)];
  for (const p of made) assert.ok(SIGNATURE_PATH_RE.test(p), p);
  assert.notEqual(bound.partA(U), bound.partA(U), "an object is single-use, so every call returns a new path");
});

test("a database/RLS refusal is an authorization verdict; network, path and session faults are setup errors", () => {
  assert.equal(classifyError(null), "ok");
  assert.equal(classifyError({ message: "new row violates row-level security policy for table \"objects\"", statusCode: "403" }), "authorization");
  assert.equal(classifyError({ message: "Not authorised to perform the security check at this station." }), "authorization");
  assert.equal(classifyError({ message: "permission denied for function x" }), "authorization");
  assert.equal(classifyError({ message: "A valid signature is required." }), "setup", "a missing/unbound signature is a fixture fault, not proof that authorization held");
  assert.equal(classifyError({ message: "The signature object was not uploaded by this account for this record." }), "setup");
  assert.equal(classifyError({ message: "FetchError: network request failed" }), "setup");
  assert.equal(classifyError({ message: "Bucket not found" }), "setup");
  assert.equal(classifyError({ message: "Invalid login credentials" }), "setup");
  assert.equal(classifyError({ message: "something unexpected" }), "setup", "an unknown error never counts as a pass");
});

test("the recorder credits only genuine authorization refusals and keeps inconclusive results out of the passes", () => {
  const out: string[] = [];
  const r = createRecorder((l: string) => out.push(l));
  assert.equal(r.expectAuthorizationDenied("rls", { outcome: "authorization", error: { message: "row-level security" } }), true);
  assert.equal(r.expectAuthorizationDenied("fixture", { outcome: "setup", error: { message: "A valid signature is required." } }), false);
  assert.equal(r.expectAuthorizationDenied("not refused", { outcome: "ok", error: null }), false);
  assert.equal(r.expectOk("fine", { outcome: "ok", error: null }), true);
  assert.equal(r.expectOk("refused", { outcome: "authorization", error: { message: "no" } }), false);
  assert.equal(r.expectAuthorizationDenied("named refusal", { error: { message: "The signature is not the one uploaded for this record." } }, /not the one uploaded/), true);
  assert.deepEqual(r.state, { failures: 2, setupErrors: 1, passes: 3 });
  assert.equal(r.exitCode(), 1);
  const only = createRecorder(() => {});
  only.expectAuthorizationDenied("x", { outcome: "setup", error: { message: "fetch failed" } });
  assert.equal(only.exitCode(), 2, "a run with only inconclusive steps is not a pass");
  assert.equal(createRecorder(() => {}).exitCode(), 0);
  assert.ok(out.some((l) => l.startsWith("INCONCLUSIVE:")));
});

test("uploads go through the actor's own session, never upsert, and a refused fixture raises a SetupError", async () => {
  const calls: { path: string; opts: Record<string, unknown> }[] = [];
  const session = (error: unknown) => ({ sb: { storage: { from: (b: string) => { assert.equal(b, "signatures"); return { upload: async (path: string, bytes: Buffer, opts: Record<string, unknown>) => { calls.push({ path, opts }); assert.equal(bytes, PNG_BYTES); return { error }; } }; } } } });
  const ok = await uploadBound(session(null), bound.partA(U));
  assert.equal(ok.outcome, "ok");
  assert.equal(calls[0].opts.upsert, false);
  const denied = await uploadBound(session({ message: "new row violates row-level security policy", statusCode: "403" }), bound.partA(U));
  assert.equal(denied.outcome, "authorization");
  await assert.rejects(uploadRequired(session({ message: "new row violates row-level security policy", statusCode: "403" }), bound.partA(U), "Part A"), SetupError);
  assert.equal(await uploadRequired(session(null), bound.partA(U), "Part A") !== "", true);
});

test("source: the four staging scripts no longer fabricate signature paths and use the shared helpers", () => {
  for (const f of ["verify-storage-staging.mjs", "e2e-external-workflows.mjs", "verify-external-workflows-staging.mjs", "targeted-part-b-probe.mjs"]) {
    const src = fs.readFileSync(`scripts/staging/${f}`, "utf8");
    assert.match(src, /signature-fixtures\.mjs/, `${f} imports the shared helpers`);
    assert.doesNotMatch(src, /p_signature_url:\s*"(?:signatures\/|x"|part-b\/uat-)/, `${f} passes no fabricated signature path`);
    // an unrecognised name may appear ONLY as a denial probe (the loop that lists it feeds every name to expectAuthorizationDenied)
    for (const line of src.split("\n").filter((l) => l.includes("e2e-probe/"))) assert.ok(f === "verify-storage-staging.mjs" && line.includes("arbitrary-test"), `${f}: an unrecognised name outside a denial probe: ${line.trim().slice(0, 80)}`);
    if (f === "verify-storage-staging.mjs") assert.ok(src.includes("upload of an unrecognised name") && src.includes("rec.expectAuthorizationDenied(`${label}: upload of an unrecognised name"), "unrecognised names are credited only as authorization denials");
    assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE|resolveStagingAdminContext\(\)\.client\.storage\.from\("signatures"\)\.upload/, `${f} does not bypass Storage RLS to create signature fixtures`);
  }
});

test("when a specific refusal is named it is REQUIRED: a different error is inconclusive, never credited", () => {
  const r = createRecorder(() => {});
  assert.equal(r.expectAuthorizationDenied("named rule", { error: { message: "Not found" } }, /whitelist/i), false);
  assert.equal(r.state.setupErrors, 1);
  assert.equal(r.state.passes, 0);
  assert.equal(r.expectAuthorizationDenied("named rule matched", { error: { message: "Vehicle is not on the whitelist" } }, /whitelist/i), true);
  assert.equal(r.expectAuthorizationDenied("action succeeded", { outcome: "ok", error: null }, /whitelist/i), false);
  assert.equal(r.state.failures, 1, "an action that was NOT refused is a failed control");
  assert.equal(classifyError({ message: "already exists" }), "setup", "generic words no longer count as an authorization verdict");
  assert.equal(classifyError({ message: "Delivery not found." }), "setup");
});

test("both gates are credited separately and a missing RPC gate is inconclusive", () => {
  const out: string[] = [];
  const r = createRecorder((l: string) => out.push(l));
  const denied = { outcome: "authorization", error: { message: "new row violates row-level security policy" } };
  assert.equal(r.expectBothGatesDenied("officer at another station", { upload: denied, rpc: { outcome: "authorization", error: { message: "Not authorised to perform the security check at this station." } } }), true);
  assert.equal(r.state.passes, 2);
  assert.equal(r.expectBothGatesDenied("rpc lost its check", { upload: denied, rpc: { outcome: "ok", error: null } }), false);
  assert.equal(r.state.failures, 1, "the RPC gate failing is visible even though the Storage gate held");
  assert.equal(r.expectBothGatesDenied("rpc not exercised", { upload: denied }), false);
  assert.ok(out.some((l) => l.includes("RPC gate was not exercised")));
});

test("clean-up removes only this run's objects that the database says are unreferenced", async () => {
  const mod = await import("../scripts/staging/lib/signature-fixtures.mjs");
  mod.createdPaths.push("a", "b", "c");
  const removed: string[][] = [];
  const admin = {
    rpc: async (_n: string, a: { p_name: string }) => (a.p_name === "a" ? { data: false, error: null } : a.p_name === "b" ? { data: true, error: null } : { data: null, error: { message: "down" } }),
    storage: { from: () => ({ remove: async (p: string[]) => { removed.push(p); return { data: p.map((n) => ({ name: n })) }; } }) },
  };
  await mod.cleanupOwnOrphans(admin, "signatures", () => {});
  assert.deepEqual(removed, [["a"]], "a referenced object and an object of unknown state are kept");
  assert.equal(mod.createdPaths.length, 0);
});
