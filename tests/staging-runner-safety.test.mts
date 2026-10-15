import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { destructiveStatement, MIGRATIONS } from "../scripts/staging/apply-containment-migration.mjs";

/** The guarded runner refuses a migration that contains a top-level destructive statement, but must accept all five reviewed files. */
test("the destructive-statement gate accepts every reviewed migration (bounded clean-up inside a function body is not a top-level statement)", () => {
  assert.equal(MIGRATIONS.length, 5);
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
  assert.match(src, /await pass\(false\);[\s\S]{0,700}if \(!LIVE\) return;[\s\S]{0,200}await pass\(true\)/);
  assert.match(src, /if \(!real\) \{ await client\.query\("ROLLBACK"\)/);
});
