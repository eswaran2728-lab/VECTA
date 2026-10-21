import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildHierarchy, HIERARCHY_CREATION_ACTIVE } from "../lib/super-admin/hierarchy.ts";
import { OrgManager } from "../app/super-admin/org-manager.tsx";

const rows = {
  aocs: [{ id: "a2", code: "ID", name: "Indonesia AOC", is_active: false }, { id: "a1", code: "MY", name: "Malaysia AOC", is_active: true }],
  entities: [
    { id: "e2", aoc_id: "a1", code: "AAX", name: "AirAsia X", flight_prefix: "D7" },
    { id: "e1", aoc_id: "a1", code: "MAA", name: "Malaysia AirAsia", flight_prefix: "AK" },
  ],
  departments: [{ id: "d2", aoc_id: "a1", code: "enforcement", name: "Enforcement" }, { id: "d1", aoc_id: "a1", code: "operation", name: "Operation" }],
  hubs: [{ id: "h1", aoc_id: "a1", code: "KUL", name: "Kuala Lumpur" }],
  stations: [{ id: "s1", hub_id: "h1" }, { id: "s2", hub_id: "h1" }, { id: "sx", hub_id: "unknown" }],
};

test("buildHierarchy groups the canonical rows under their AOC, sorted by code, with station counts per hub", () => {
  const h = buildHierarchy(rows);
  assert.deepEqual(h.map((a) => a.code), ["ID", "MY"]);
  const my = h[1];
  assert.equal(my.name, "Malaysia AOC");
  assert.equal(my.isActive, true);
  assert.deepEqual(my.entities.map((e) => `${e.code}:${e.flightPrefix}`), ["AAX:D7", "MAA:AK"]);
  assert.deepEqual(my.departments.map((d) => d.code), ["enforcement", "operation"]);
  assert.deepEqual(my.hubs, [{ code: "KUL", name: "Kuala Lumpur", stationCount: 2 }]);
  assert.deepEqual(h[0].entities, []);
});

test("buildHierarchy never invents scopes: unknown parents are ignored and empty input gives an empty hierarchy", () => {
  assert.deepEqual(buildHierarchy({ aocs: [], entities: [], departments: [], hubs: [], stations: [] }), []);
  const h = buildHierarchy({ ...rows, entities: [{ id: "x", aoc_id: "missing", code: "ZZZ", name: "Orphan", flight_prefix: "ZZ" }] });
  assert.ok(!JSON.stringify(h).includes("ZZZ"));
});

test("creation of AOCs / operating entities is NOT activated (a business decision), and the view says so", () => {
  assert.equal(HIERARCHY_CREATION_ACTIVE, false);
  const html = renderToStaticMarkup(React.createElement(OrgManager, { hierarchy: buildHierarchy(rows) }));
  assert.match(html, /Malaysia AOC/);
  assert.match(html, /MAA/);
  assert.match(html, /AAX/);
  assert.match(html, /not activated/i);
  assert.doesNotMatch(html, /<form|<input|<button|Create Tenant|Add Organization|multi-tenant/i, "no creation controls and no multi-tenant wording");
});

test("the empty state is a clear message, not a crash or a fake organization", () => {
  const html = renderToStaticMarkup(React.createElement(OrgManager, { hierarchy: [] }));
  assert.match(html, /No AOC is configured|not available/i);
  assert.match(html, /not activated/i);
});

test("the Super Admin actions no longer read or write the retired public.organizations table and keep the canonical authority gate first", () => {
  const src = fs.readFileSync("lib/super-admin/actions.ts", "utf8");
  assert.doesNotMatch(src, /["']organizations["']/);
  assert.doesNotMatch(src, /createOrganization|updateOrganizationStatus|OrganizationRow/);
  const fn = src.slice(src.indexOf("export async function getOrganizationHierarchy"));
  assert.ok(fn.length > 50, "getOrganizationHierarchy exists");
  assert.ok(fn.indexOf("isSuperAdmin()") !== -1 && fn.indexOf("isSuperAdmin()") < fn.indexOf("createAdminClient()"), "the Super Admin check precedes any service-key read");
  for (const t of ["aocs", "operating_entities", "departments", "hubs", "org_stations"]) assert.match(fn, new RegExp(`from\\("${t}"\\)`));
  assert.doesNotMatch(fn, /\.(insert|update|upsert|delete)\(/, "read-only");
});

test("the page and component use the canonical hierarchy only", () => {
  const page = fs.readFileSync("app/super-admin/page.tsx", "utf8");
  assert.match(page, /getOrganizationHierarchy/);
  assert.doesNotMatch(page, /getOrganizations|createOrganization/);
  const ui = fs.readFileSync("app/super-admin/org-manager.tsx", "utf8");
  assert.doesNotMatch(ui, /createOrganization|updateOrganizationStatus|useState/);
});
