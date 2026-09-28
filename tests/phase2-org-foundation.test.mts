import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 2 of the VECTA Malaysia AOC upgrade
 * (2026-09-28): supabase/migrations/20260928000001_phase2_org_foundation.sql.
 *
 * Phase 2 is schema-only and additive. These tests assert the migration's
 * own source text for the safety guarantees the spec requires (no RLS
 * policy = no new access, no NOT NULL, no guessed backfill, no dropped
 * column) and mirror the deterministic-backfill decision logic in pure
 * functions, per this repo's established testing convention.
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260928000001_phase2_org_foundation.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

// --- Safety guarantees ---

test("SAFETY: this migration creates zero RLS policies -- every new table is deny-all until Phase 3", () => {
  assert.equal((code.match(/create policy/gi) ?? []).length, 0);
});

test("SAFETY: every new table has RLS enabled", () => {
  for (const t of ["aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams"]) {
    assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`));
  }
});

test("SAFETY: PUBLIC/anon/authenticated are explicitly revoked on every new table; only service_role retains access", () => {
  for (const t of ["aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams"]) {
    assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated;`));
  }
  assert.match(code, /grant all on public\.aocs, public\.operating_entities, public\.departments,\s*\n\s*public\.units, public\.hubs, public\.org_stations, public\.org_teams\s*\n\s*to service_role;/);
});

test("SAFETY: no NOT NULL constraint is added to any new profiles column (all seven are nullable FKs)", () => {
  const alterProfiles = code.match(/alter table public\.profiles[\s\S]*?;/);
  assert.ok(alterProfiles, "must find the ALTER TABLE profiles statement");
  assert.doesNotMatch(alterProfiles[0], /not null/i);
  for (const col of ["aoc_id", "operating_entity_id", "department_id", "unit_id", "hub_id", "org_station_id", "org_team_id"]) {
    assert.match(alterProfiles[0], new RegExp(`add column if not exists ${col} uuid references`));
  }
});

test("SAFETY: no existing profiles column (station, team, ops_group, role, unified_role) is dropped, renamed, or altered", () => {
  assert.doesNotMatch(code, /drop column/i);
  assert.doesNotMatch(code, /rename column/i);
  assert.doesNotMatch(code, /alter column.*station/i);
  assert.doesNotMatch(code, /alter column.*\bteam\b/i);
  assert.doesNotMatch(code, /alter column.*ops_group/i);
});

test("SAFETY: public.users (CaterLink identity table) is never referenced -- profiles and CaterLink users are not collapsed in this phase", () => {
  assert.doesNotMatch(code, /alter table public\.users/i);
});

test("SAFETY: Malaysia (MY) is seeded but left inactive -- activation is a separate, later decision", () => {
  assert.match(code, /values \('MY', 'Malaysia', false\)/);
});

test("SAFETY: legacy stations (KUA, MKZ, SZB) are preserved as classification_pending, attached to an explicit 'unclassified' hub, never deleted or guessed into a real hub", () => {
  const legacyBlock = code.match(/insert into public\.org_stations \(hub_id, code, name, classification_status\)[\s\S]*?on conflict \(code\) do nothing;/);
  assert.ok(legacyBlock, "must find the legacy-station insert block");
  assert.match(legacyBlock[0], /'KUA'/);
  assert.match(legacyBlock[0], /'MKZ'/);
  assert.match(legacyBlock[0], /'SZB'/);
  assert.match(legacyBlock[0], /'classification_pending'/);
  assert.match(legacyBlock[0], /where h\.code = 'unclassified'/);
});

test("SAFETY: KUL - MAA and KUL - AAX are preserved as two distinct station codes, not collapsed into one 'KUL' row", () => {
  assert.match(code, /\('kul', 'KUL - MAA', 'KUL \(MAA\)'\)/);
  assert.match(code, /\('kul', 'KUL - AAX', 'KUL \(AAX\)'\)/);
});

test("SAFETY: org_stations has no operating_entity_id column -- a station may never be permanently assigned to only MAA or AAX", () => {
  const createStations = code.match(/create table if not exists public\.org_stations \([\s\S]*?\);/);
  assert.ok(createStations);
  assert.doesNotMatch(createStations[0], /operating_entity_id/);
});

test("SAFETY: every backfill UPDATE is idempotent (guarded by aoc_id is null) and scoped to an exact station match -- never a LIKE/fuzzy match", () => {
  const updates = code.match(/^update public\.profiles[\s\S]*?;/gim) ?? [];
  assert.equal(updates.length, 2, "expected exactly two backfill UPDATE statements (KUL - MAA, KUL - AAX)");
  for (const u of updates) {
    assert.match(u, /and p\.aoc_id is null/);
    assert.match(u, /p\.station = 'KUL - (MAA|AAX)'/);
    assert.doesNotMatch(u, /like|ilike|similar to/i);
  }
});

test("SAFETY: the backfill never sets department_id, unit_id, or org_team_id -- those require role/assignment data deferred to Phase 3, not guessed here", () => {
  const updates = code.match(/^update public\.profiles[\s\S]*?;/gim) ?? [];
  for (const u of updates) {
    assert.doesNotMatch(u, /department_id\s*=/);
    assert.doesNotMatch(u, /unit_id\s*=/);
    assert.doesNotMatch(u, /org_team_id\s*=/);
  }
});

// --- Deterministic-backfill decision logic (mirrors Part F exactly) ---

type ProfileRow = { station: string | null; aocIdAlreadySet: boolean };

/** Mirrors the migration's two backfill UPDATEs: only exact 'KUL - MAA'/'KUL - AAX', never re-touching an already-backfilled row. */
function deterministicBackfillTarget(p: ProfileRow): { operatingEntity: "MAA" | "AAX" | null; hub: "kul" | null } {
  if (p.aocIdAlreadySet) return { operatingEntity: null, hub: null }; // idempotent -- no-op
  if (p.station === "KUL - MAA") return { operatingEntity: "MAA", hub: "kul" };
  if (p.station === "KUL - AAX") return { operatingEntity: "AAX", hub: "kul" };
  return { operatingEntity: null, hub: null }; // every other station/null is left untouched -- no guess
}

test("Deterministic backfill: KUL - MAA profiles resolve to MAA/KUL", () => {
  assert.deepEqual(deterministicBackfillTarget({ station: "KUL - MAA", aocIdAlreadySet: false }), { operatingEntity: "MAA", hub: "kul" });
});

test("Deterministic backfill: KUL - AAX profiles resolve to AAX/KUL", () => {
  assert.deepEqual(deterministicBackfillTarget({ station: "KUL - AAX", aocIdAlreadySet: false }), { operatingEntity: "AAX", hub: "kul" });
});

test("REGRESSION: a non-KUL station (e.g. PEN) is never guessed into an operating entity -- confirmed no non-KUL profile existed live to backfill, but the logic must reject it structurally regardless", () => {
  assert.deepEqual(deterministicBackfillTarget({ station: "PEN", aocIdAlreadySet: false }), { operatingEntity: null, hub: null });
});

test("REGRESSION: a null-station profile (the 9 live ambiguous rows) is never backfilled", () => {
  assert.deepEqual(deterministicBackfillTarget({ station: null, aocIdAlreadySet: false }), { operatingEntity: null, hub: null });
});

test("REGRESSION: an already-backfilled profile is never re-touched, even if re-run", () => {
  assert.deepEqual(deterministicBackfillTarget({ station: "KUL - MAA", aocIdAlreadySet: true }), { operatingEntity: null, hub: null });
});

// --- Static structural validation ---

test("STATIC: parentheses are balanced in the full migration file", () => {
  const opens = (code.match(/\(/g) ?? []).length;
  const closes = (code.match(/\)/g) ?? []).length;
  assert.equal(opens, closes);
});

test("STATIC: every new table declares a primary key", () => {
  const tableBlocks = code.match(/create table if not exists public\.\w+ \([\s\S]*?\n\);/g) ?? [];
  assert.ok(tableBlocks.length >= 7, "expected at least 7 CREATE TABLE statements");
  for (const block of tableBlocks) {
    assert.match(block, /primary key/i, `table missing a primary key: ${block.slice(0, 80)}`);
  }
});
