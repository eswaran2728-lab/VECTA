import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(file, "utf8");

test("approved shift staff can browse AVSEC without an open duty record", () => {
  const middleware = read("lib/supabase/middleware.ts");
  assert.doesNotMatch(middleware, /checkinRequired|alreadyOnCheckin|checkin-gate-unavailable/);
  assert.doesNotMatch(middleware, /url\.pathname = "\/avsec\/duty"/);
  assert.match(middleware, /isAdminPathForbiddenFor/);
  assert.match(middleware, /isMainEnforcementPathForbidden/);
});

test("every security report form explains check-in without removing the server submit gate", () => {
  const actions = read("lib/avsec/reports/actions.ts");
  assert.equal((actions.match(/await ensureCheckedIn\(profile\.id\)/g) ?? []).length, 8);
  const notice = read("components/avsec/forms/ReportSubmitDutyNotice.tsx");
  assert.match(notice, /Check in to submit/);
  assert.match(notice, /\/avsec\/duty/);
  for (const form of ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "makeup", "breakup"]) {
    assert.match(read(`app/(avsec)/avsec/reports/${form}/page.tsx`), /ReportSubmitDutyNotice/, form);
  }
});

test("the hosted UAT checks off-duty navigation while preserving physical-action refusal", () => {
  const uat = read("scripts/staging/hosted-uat.mjs");
  assert.match(uat, /before duty, .* opens without check-in/);
  assert.doesNotMatch(uat, /redirects to the duty gate|behind the duty check-in gate/);
  assert.match(uat, /without an open duty check-in .* is refused/);
});
