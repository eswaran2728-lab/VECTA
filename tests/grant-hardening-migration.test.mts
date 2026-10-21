import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SQL = fs.readFileSync("supabase/migrations/20261118000004_revoke_excess_authenticated_grants.sql", "utf8");
const code = SQL.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
const statements = code.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

test("the ACL hardening migration contains only revokes from authenticated (plus a lock timeout) and never grants anything", () => {
  assert.ok(statements.length > 80);
  for (const s of statements) {
    assert.match(
      s,
      /^(set local lock_timeout = '5s'|revoke truncate, trigger, references on table public\.[a-z0-9_]+ from authenticated|revoke insert, update, delete on table public\.v_[a-z0-9_]+ from authenticated|revoke delete on table public\.shift_handovers from authenticated|revoke execute on function public\.[a-z0-9_]+\(\) from authenticated)$/,
      s,
    );
  }
  assert.doesNotMatch(code, /\bgrant\b|\bpolicy\b|\bcreate\b|\balter\b|\bdrop\b|\bdelete from\b|\btruncate table\b/i);
});

test("it removes the dangerous privileges, keeps SELECT / INSERT / UPDATE and the designed DELETEs, and touches no table it should not", () => {
  const tables = statements.filter((s) => s.startsWith("revoke truncate")).map((s) => /public\.([a-z0-9_]+)/.exec(s)![1]);
  assert.equal(new Set(tables).size, tables.length, "no table is revoked twice");
  for (const mustKeep of ["profiles", "report_sec013", "duty_records", "overtime_requests"]) assert.ok(tables.includes(mustKeep), `${mustKeep} loses only truncate/trigger/references`);
  assert.ok(!statements.some((s) => /revoke (select|insert|update|all)\b/.test(s) && !s.includes(" public.v_")), "no read/insert/update/all revoke outside the reporting views");
  const deletes = statements.filter((s) => /^revoke delete\b/.test(s));
  assert.deepEqual(deletes, ["revoke delete on table public.shift_handovers from authenticated"], "the only DELETE removed from a base table is shift_handovers");
  const viewRevokes = statements.filter((s) => s.startsWith("revoke insert, update, delete"));
  assert.ok(viewRevokes.length >= 5 && viewRevokes.every((s) => /public\.v_/.test(s)), "write privileges are removed only from reporting views");
  assert.ok(!statements.some((s) => /\b(anon|public|service_role)\b/.test(s.replace(/public\./g, ""))), "only authenticated is narrowed; service_role and anon are untouched");
  const fns = statements.filter((s) => s.startsWith("revoke execute"));
  assert.ok(fns.length >= 25);
  assert.ok(!fns.some((s) => /is_entity_admin|has_role_in_scope|get_my_active|auth\./.test(s)), "no callable RPC/helper loses EXECUTE -- trigger functions only");
});
