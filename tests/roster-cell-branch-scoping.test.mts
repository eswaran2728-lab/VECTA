import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of the roster admin page's teammate/cell-scoping logic
 * (app/(avsec)/avsec/admin/roster/page.tsx), fixed 2026-09-23 after a
 * live baseline smoke test found: opening an IFC ALPHA roster cell
 * warned that saving would also update Operation ALPHA officers. Root
 * cause: the teammates list and cell lookup were keyed by team name
 * alone, and team names collide across AVSEC branches (both Operation
 * and IFC AVSEC can have a "Team ALPHA" at the same station).
 */
interface Officer {
  id: string;
  name: string;
  team: string;
  ops_group: string | null;
}

function buildTeammatesByTeam(officers: Officer[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const o of officers) {
    if (!o.team) continue;
    const key = `${o.team}|${o.ops_group ?? ""}`;
    const list = map.get(key) ?? [];
    list.push(o.name);
    map.set(key, list);
  }
  return map;
}

const opsAlphaAso: Officer = { id: "1", name: "ASO Alpha (Ops)", team: "ALPHA", ops_group: "operation_avsec" };
const opsAlphaSo: Officer = { id: "2", name: "SO Alpha (Ops)", team: "ALPHA", ops_group: "operation_avsec" };
const ifcAlphaAso: Officer = { id: "3", name: "ASO Alpha (IFC)", team: "ALPHA", ops_group: "ifc_avsec" };
const ifcAlphaSo: Officer = { id: "4", name: "SO Alpha (IFC)", team: "ALPHA", ops_group: "ifc_avsec" };
const hubAlpha: Officer = { id: "5", name: "Hub Officer Alpha", team: "ALPHA", ops_group: "hub_avsec" };

const allOfficers = [opsAlphaAso, opsAlphaSo, ifcAlphaAso, ifcAlphaSo, hubAlpha];

test("REGRESSION: editing an IFC ALPHA cell's teammates list contains only IFC ALPHA officers, not Operation ALPHA", () => {
  const teammatesByTeam = buildTeammatesByTeam(allOfficers);
  const ifcTeammates = (teammatesByTeam.get("ALPHA|ifc_avsec") ?? []).filter((n) => n !== ifcAlphaAso.name);
  assert.deepEqual(ifcTeammates, ["SO Alpha (IFC)"]);
  assert.ok(!ifcTeammates.includes("ASO Alpha (Ops)"));
  assert.ok(!ifcTeammates.includes("SO Alpha (Ops)"));
});

test("REGRESSION: editing an Operation ALPHA cell's teammates list contains only Operation ALPHA officers, not IFC ALPHA", () => {
  const teammatesByTeam = buildTeammatesByTeam(allOfficers);
  const opsTeammates = (teammatesByTeam.get("ALPHA|operation_avsec") ?? []).filter((n) => n !== opsAlphaAso.name);
  assert.deepEqual(opsTeammates, ["SO Alpha (Ops)"]);
  assert.ok(!opsTeammates.includes("ASO Alpha (IFC)"));
  assert.ok(!opsTeammates.includes("SO Alpha (IFC)"));
});

test("REGRESSION: Hub ALPHA remains its own separate bucket, not merged into Operation or IFC", () => {
  const teammatesByTeam = buildTeammatesByTeam(allOfficers);
  assert.deepEqual(teammatesByTeam.get("ALPHA|hub_avsec"), ["Hub Officer Alpha"]);
});

interface RosterRow {
  team: string;
  ops_group: string | null;
  roster_date: string;
  shift_code: string;
}

function buildCellMap(rows: RosterRow[]): Map<string, RosterRow> {
  const map = new Map<string, RosterRow>();
  for (const row of rows) map.set(`${row.team}|${row.ops_group ?? ""}|${row.roster_date}`, row);
  return map;
}

test("REGRESSION: an Operation ALPHA roster row and an IFC ALPHA roster row for the same date do not collide in the cell map", () => {
  const rows: RosterRow[] = [
    { team: "ALPHA", ops_group: "operation_avsec", roster_date: "2026-09-23", shift_code: "M1" },
    { team: "ALPHA", ops_group: "ifc_avsec", roster_date: "2026-09-23", shift_code: "N1" },
  ];
  const cellMap = buildCellMap(rows);
  assert.equal(cellMap.get("ALPHA|operation_avsec|2026-09-23")?.shift_code, "M1");
  assert.equal(cellMap.get("ALPHA|ifc_avsec|2026-09-23")?.shift_code, "N1");
  assert.equal(cellMap.size, 2);
});

/** Pure model of the "Set Shift by Team" bulk selector requirement. */
function bulkRosterFormValid(formOpsGroup: string): boolean {
  const VALID = ["operation_avsec", "ifc_avsec", "hub_avsec"];
  return VALID.includes(formOpsGroup);
}

test("REGRESSION: bulk roster submission requires a group - empty/missing selection is rejected", () => {
  assert.equal(bulkRosterFormValid(""), false);
});

test("REGRESSION: bulk roster submission accepts all 3 valid groups, including Hub", () => {
  assert.equal(bulkRosterFormValid("operation_avsec"), true);
  assert.equal(bulkRosterFormValid("ifc_avsec"), true);
  assert.equal(bulkRosterFormValid("hub_avsec"), true);
});

test("REGRESSION: bulk roster submission rejects an invalid group value", () => {
  assert.equal(bulkRosterFormValid("not_a_real_group"), false);
});
