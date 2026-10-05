import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Merged operations model (2026-10-05): IFC AVSEC and Operation AVSEC are one
// structure. `ops_group` is DEPRECATED for authorization. Historical column
// values may remain readable only in the files below; nothing may compare,
// filter, select, group or branch on it, and no code may name the retired groups.
const REPO = path.resolve(import.meta.dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Historical-compatibility allowlist: type shapes of existing columns / generated types only.
const HISTORICAL_ONLY = new Set([
  "lib/avsec/types.ts",
  "lib/icms/database.types.ts",
  "lib/supabase/database.types.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const FILES = ["app", "lib", "components"].flatMap((d) => walk(d));

const BANNED: Array<[string, RegExp]> = [
  ["property access (.ops_group)", /\.ops_group\b/],
  ["camelCase (opsGroup)", /\bopsGroup\b/],
  ["bare string key ('ops_group')", /["'`]ops_group["'`]/],
  ["select/filter/order mentioning ops_group", /\.(select|eq|neq|in|order|filter|match|or)\([^)]*\bops_group\b/],
  ["retired group names", /\b(ifc_avsec|operation_avsec)\b/],
  ["group constants/types", /\bOPS_GROUP\w*|\bOpsGroup\b/],
];

test("closure: no handwritten production code reads, filters, compares or names ops_group / the retired groups", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    if (HISTORICAL_ONLY.has(file)) continue;
    // Writing a literal null into a historical column is the only permitted mention.
    const code = strip(fs.readFileSync(path.join(REPO, file), "utf8")).replace(/\bops_group:\s*null\b,?/g, "");
    for (const [label, rx] of BANNED) if (rx.test(code)) offenders.push(`${file}: ${label}`);
  }
  assert.deepEqual(offenders, [], `new ops_group dependency introduced:\n${offenders.join("\n")}`);
});

test("closure: ops_group is never WRITTEN with a non-null value by production code", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    if (HISTORICAL_ONLY.has(file)) continue;
    const code = strip(fs.readFileSync(path.join(REPO, file), "utf8"));
    for (const m of code.matchAll(/\bops_group:\s*([^,}\n]+)/g)) {
      if (m[1].trim() !== "null") offenders.push(`${file}: ops_group: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("closure: the allowlist stays minimal -- only type declarations of the historical column", () => {
  const profileType = fs.readFileSync(path.join(REPO, "lib/avsec/types.ts"), "utf8");
  assert.match(profileType, /ops_group:/);
  assert.match(profileType, /deprecated|historical|never decide/i, "the Profile type must document ops_group as non-authoritative");
  for (const f of HISTORICAL_ONLY) assert.ok(fs.existsSync(path.join(REPO, f)), f);
});

test("closure: legacy ops-group authority modules and tests stay deleted", () => {
  for (const f of ["lib/icms/ops-group.ts", "tests/ops-group.test.mts", "tests/unified-avsec-checkpoint-workflow.test.mts"]) {
    assert.ok(!fs.existsSync(path.join(REPO, f)), `${f} must not return`);
  }
});


test("migration: nothing the compatibility migration introduces compares ops_group (except the profile guard's self-edit immutability checks)", () => {
  const raw = fs.readFileSync(path.join(REPO, "supabase/migrations/20261020000001_canonical_operations_compatibility.sql"), "utf8").replace(/--[^\n]*/g, "");
  // enforce_profile_self_update() keeps its existing "ops_group may not be self-edited" immutability
  // comparisons: they PROTECT the historical column from writes and grant nothing.
  const guardStart = raw.indexOf("create or replace function public.enforce_profile_self_update()");
  const guardEnd = raw.indexOf("$function$;", raw.indexOf("as $function$", guardStart)) + "$function$;".length;
  assert.ok(guardStart > 0 && guardEnd > guardStart, "profile guard present");
  const sql = raw.slice(0, guardStart) + raw.slice(guardEnd);
  assert.ok(!/ops_group\s*(=|<>|!=|\bin\b|\bis\b)/i.test(sql.replace(/p_ops_group text/gi, "")), "no ops_group comparison");
  assert.ok(!/\bifc_avsec\b|\boperation_avsec\b/.test(sql), "no retired group names");
  const guard = raw.slice(guardStart, guardEnd);
  for (const m of guard.matchAll(/[^\n]*ops_group[^\n]*/g)) {
    assert.match(m[0], /is distinct from|<>/, `guard mention must be an immutability check: ${m[0].trim()}`);
  }
});
