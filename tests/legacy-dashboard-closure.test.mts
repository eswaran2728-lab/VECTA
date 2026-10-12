import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p: string) => fs.readFileSync(p, "utf8");

test("legacy generic dashboard family is gated by requireLegacyManagementDashboard on all three pages", () => {
  for (const f of ["dashboard/page.tsx", "dashboard/heatmap/page.tsx", "dashboard/duty-monitor/page.tsx"]) {
    const src = read(`app/(avsec)/avsec/${f}`);
    assert.match(src, /await requireLegacyManagementDashboard\(\)/, f);
    assert.doesNotMatch(src, /requireRouteAccess\(|requireRole\(/, `${f} must not keep a role-list gate`);
  }
});

test("only operation_manager may open the legacy dashboard; everyone else is redirected to their own workspace; fail closed", () => {
  const auth = read("lib/avsec/auth.ts");
  assert.match(auth, /LEGACY_MANAGEMENT_DASHBOARD_ROLE_CODES: readonly string\[\] = \["operation_manager"\]/);
  const fn = auth.slice(auth.indexOf("export async function requireLegacyManagementDashboard"));
  assert.match(fn.slice(0, 500), /redirect\("\/avsec\/my-dashboard"\)/);
  assert.doesNotMatch(fn.slice(0, 500), /redirect\("\/avsec\/dashboard"\)/);
});

test("denials never bounce back to the legacy dashboard (no redirect loop); a role without a workspace gets a notice", () => {
  assert.match(read("lib/phase8/auth.ts"), /redirect\("\/avsec\/my-dashboard"\)/);
  const my = read("app/(avsec)/avsec/my-dashboard/page.tsx");
  assert.doesNotMatch(my, /redirect\("\/avsec\/dashboard"\)/);
  assert.match(my, /No workspace is configured for your role/);
});
