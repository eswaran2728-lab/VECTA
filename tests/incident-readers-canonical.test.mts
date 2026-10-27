import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * The legacy `incidents` table does not exist on the canonical Phase 9 environment, so a reader of it returns nothing and the
 * failure is swallowed: an open escalation (including one raised by the Part B checkpoint) never reached the operational views.
 * Every VECTA-side reader must use the canonical `caterlink_incidents` table (row-level security scopes who sees what).
 */
const READERS = [
  "app/page.tsx",
  "app/(avsec)/avsec/admin/alerts/page.tsx",
  "lib/avsec/duty/handover-queries.ts",
  "lib/dashboard/flight-detail.ts",
  "lib/dashboard/needs-your-action.ts",
];

for (const f of READERS) {
  test(`${f} reads canonical incidents, not the legacy table`, () => {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\.from\("incidents"\)/, "no legacy incidents query");
    assert.match(src, /\.from\("caterlink_incidents" as never\)/);
    assert.doesNotMatch(src, /\.is\("resolved_at", null\)\s*\.limit/, "canonical incidents are filtered by status, not by the legacy resolved_at flag");
  });
}

test("the shift handover summary resolves the station by id and no longer reads absent legacy transaction columns", () => {
  const src = fs.readFileSync("lib/avsec/duty/handover-queries.ts", "utf8");
  assert.match(src, /from\("org_stations"\)\.select\("id"\)\.eq\("code", station\)/);
  assert.match(src, /origin_station_id/);
  assert.match(src, /createAdminClient\(\)\.from\("org_stations"\)/, "signed-in users cannot read org_stations: the id lookup is a server-side reference read");
  assert.doesNotMatch(src, /supabase\.from\("org_stations"\)/);
  assert.doesNotMatch(src, /escort_officer_name|\.eq\("station", station\)/);
});
