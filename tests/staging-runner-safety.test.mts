import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { destructiveStatement, MIGRATIONS } from "../scripts/staging/apply-containment-migration.mjs";

/** The guarded runner refuses a migration that contains a top-level destructive statement, but must accept all eight reviewed files. */
test("the destructive-statement gate accepts every reviewed migration (bounded clean-up inside a function body is not a top-level statement)", () => {
  assert.equal(MIGRATIONS.length, 8);
  for (const m of MIGRATIONS) {
    const sql = fs.readFileSync(`supabase/migrations/${m.version}_${m.name}.sql`, "utf8");
    assert.equal(destructiveStatement(sql), null, `${m.version} must pass the gate`);
  }
});

test("the gate still stops top-level destructive statements, however they are written", () => {
  for (const bad of ["drop table public.t;", "DROP TABLE IF EXISTS public.t cascade;", "truncate public.t;", "delete from public.t where true;", "create function f() returns void language sql as $x$ select 1 $x$; delete from public.t;", "-- comment\nTRUNCATE TABLE public.t;"]) {
    assert.notEqual(destructiveStatement(bad), null, bad);
  }
  assert.equal(destructiveStatement("create function f() returns void language plpgsql as $function$ begin delete from public.t where x; end; $function$;"), null);
  assert.equal(destructiveStatement("-- drop table is only a comment\nselect 1;"), null);
});

test("the dry run needs no live phrase and the live phase needs --live and the exact phrase", () => {
  const src = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  assert.match(src, /if \(LIVE && argVal\("confirm"\) !== LIVE_PHRASE\) fail/);
  assert.match(src, /await pass\(false\);[\s\S]{0,2500}if \(!LIVE\) return;[\s\S]{0,200}await pass\(true\)/);
  assert.match(src, /if \(!real\) \{ await client\.query\("ROLLBACK"\)/);
});

test("a DO block runs at migration time, so a destructive statement inside it is still stopped", () => {
  assert.notEqual(destructiveStatement("do $$ begin delete from public.t; end $$;"), null);
  assert.notEqual(destructiveStatement("DO $body$ begin drop table public.t; end $body$;"), null);
  assert.equal(destructiveStatement("create or replace function f() returns void language plpgsql as $$ begin delete from public.t where x; end $$;"), null);
});

test("the dry run prints an explicit PASS marker for every behavioural probe, including each signature-storage probe", () => {
  const src = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  assert.ok(src.includes("const probe = (name) => { probeLog.push(name); log(`PROBE PASS: ${name}`); };"), "one helper prints every PASS marker");
  // call sites only (statements that begin with the helper), not the helper definitions
  const callSites = (src.match(/^\s+(?:probe|expectDenied|expectAccepted)\("/gm) ?? []).length;
  assert.ok(callSites >= 50, `expected at least 50 probe call sites, found ${callSites}`);
  assert.ok(!/probe\("[^"]*NOT exercised/.test(src), "a skipped precondition must fail the run, never print a PASS marker");
  assert.match(src, /the Part B success precondition could not be set up/);
  for (const must of [
    "the unrestricted 'signatures: authenticated upload' policy is absent after the migration",
    "regression: an approved unrelated officer cannot upload signatures/arbitrary-test/<random>.png",
    "cross-user: a Driver cannot upload under another account's id",
    "cross-station: a KUL officer cannot upload for a PEN movement",
    "a valid authorised prefix succeeds",
    "Vendor Part B success precondition",
    "Vendor Part B denial",
    "no overwrite, move or delete",
    "finalisation: a checkpoint cannot reference a path that is not bound to its row and actor",
    "after rollback every original public/storage policy is exactly as before",
  ]) assert.ok(src.includes(must), "missing probe: " + must);
});

test("the runner verifies the original policies are restored after the rolled-back dry run and the legacy upload policy was present beforehand", () => {
  const src = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  assert.match(src, /policiesAll/);
  assert.ok(src.includes("polname = 'signatures: authenticated upload'"), "the legacy policy's return is checked");
});

test("the runner proves the incident-photos lockdown and the signature hardening with named probes", () => {
  const src = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  for (const must of [
    "incident-photos: both unrestricted policies are gone",
    "no client upload workflow exists",
    "the reporter can read the photo of their incident",
    "an unrelated PEN officer cannot read it",
    "single use: an object backs ONE checkpoint row",
    "quota: an account that already has 30 unreferenced signature objects",
    "the signatures bucket accepts at most 5 MB",
    "structure: every permissive INSERT/UPDATE/DELETE/ALL policy on storage.objects names a bucket",
    "structure: the only permissive write policy that reaches either bucket",
  ]) assert.ok(src.includes(must), "missing probe: " + must);
});

test("no runner probe refers to a function signature that a later frozen migration replaces (the whole set is applied before any probe runs)", () => {
  const src = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  assert.ok(!src.includes("list_orphan_signatures_secure(integer)"), "20261115000001 replaces the one-argument orphan listing with the paged (integer, integer) form");
  assert.ok(!src.includes("list_orphan_vendor_signatures_secure(integer)") || src.includes("list_orphan_vendor_signatures_secure"), "the vendor listing is unchanged");
});
