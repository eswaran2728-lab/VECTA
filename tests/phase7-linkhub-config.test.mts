import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_HUB_CONFIG, NO_SCANNER_ROLES } from "../lib/dashboard/linkHubConfig.ts";

test("no GenericLinkHubDashboard role config ever includes a checkpoint scanner link", () => {
  for (const [role, config] of Object.entries(LINK_HUB_CONFIG)) {
    for (const link of config.links) {
      assert.ok(
        !link.href.includes("/avsec/scan"),
        `role "${role}" must not have a scanner link in its Phase 7 dashboard nav (found ${link.href})`,
      );
    }
  }
});

test("NO_SCANNER_ROLES lists every Profiling and Investigation role", () => {
  for (const role of ["profiling_so", "profiling_aso", "investigation_sso", "investigation_so", "investigation_aso"]) {
    assert.ok(NO_SCANNER_ROLES.includes(role), `${role} must be listed in NO_SCANNER_ROLES`);
  }
});

test("caterlink_management dashboard never shows AVSEC report-count cards", () => {
  const config = LINK_HUB_CONFIG.caterlink_management;
  assert.equal(config.showReportCounts, false, "CaterLink Management must not receive AVSEC report content");
  for (const link of config.links) {
    assert.ok(link.href.startsWith("/icms"), `CaterLink Management link "${link.href}" must stay within /icms`);
  }
});

test("every LINK_HUB_CONFIG entry has at least one link and a non-empty title", () => {
  for (const [role, config] of Object.entries(LINK_HUB_CONFIG)) {
    assert.ok(config.title.length > 0, `role "${role}" must have a title`);
    assert.ok(config.links.length > 0, `role "${role}" must have at least one link`);
  }
});
