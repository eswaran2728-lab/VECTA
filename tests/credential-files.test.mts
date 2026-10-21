import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain .mjs tooling module
import { generateSharedPassword, renderCredentialText, renderCredentialHtml, accountExpectation } from "../scripts/staging/lib/credential-files.mjs";

test("generated shared passwords are long, mixed, shell/URL-safe and different every time", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const p = generateSharedPassword();
    assert.ok(p.length >= 24, "at least 24 characters");
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/); assert.match(p, /[-_.!@#]/);
    assert.match(p, /^[A-Za-z0-9\-_.!@#]+$/, "no quote, space, backslash, dollar or percent");
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

const accounts = [
  { label: "aso", display: "ASO PEN", roleCode: "aso", accountState: "approved", scope: "MY / MAA / PEN / team A", email: "aso.pen@vecta.test", password: "PW-PLACEHOLDER-xyz", expectedWorkspace: "/avsec/home (ASO)", kind: "station_variant" },
  { label: "neg-pending-profile", display: "Pending", roleCode: "aso", accountState: "pending", scope: "none", email: "pending.profile@vecta.test", password: "PW-PLACEHOLDER-xyz", expectedWorkspace: "/avsec/pending-approval", kind: "negative" },
];

test("the plain-text copy lists URL, the shared password once, and every account with role, id, password and expectation, in the requested layout", () => {
  const t = renderCredentialText({ url: "https://preview.example.test", password: "PW-PLACEHOLDER-xyz", accounts });
  const lines = t.split("\n");
  assert.equal(lines[0], "VECTA STAGING");
  assert.equal(lines[1], "URL: https://preview.example.test");
  assert.equal(lines[2], "PASSWORD FOR ALL POSITIVE TEST ACCOUNTS: PW-PLACEHOLDER-xyz");
  assert.match(t, /ROLE \/ ID \/ PASSWORD \/ EXPECTED/);
  assert.match(t, /ASO PEN \/ aso\.pen@vecta\.test \/ PW-PLACEHOLDER-xyz \/ /);
  assert.match(t, /Pending \/ pending\.profile@vecta\.test \/ PW-PLACEHOLDER-xyz \/ .*(restricted|denied|no functional access)/i, "negative identities state the denial");
  assert.equal(accounts.length, t.split("\n").filter((l) => l.includes("@vecta.test")).length);
});

test("expectations: positives name the landing page, negatives state that access is denied or restricted", () => {
  assert.match(accountExpectation(accounts[0]), /\/avsec\/home/);
  assert.match(accountExpectation(accounts[1]), /pending-approval/);
  assert.match(accountExpectation(accounts[1]), /no functional access/i);
});

test("the PDF source marks the document confidential, includes every account and escapes HTML in values", () => {
  const html = renderCredentialHtml({ url: "https://preview.example.test", password: "PW-PLACEHOLDER-xyz", accounts: [{ ...accounts[0], display: "<script>x</script>" }, accounts[1]] });
  assert.match(html, /CONFIDENTIAL/);
  assert.match(html, /aso\.pen@vecta\.test/);
  assert.match(html, /pending\.profile@vecta\.test/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  for (const col of ["Role", "Email", "Scope", "Landing", "State"]) assert.match(html, new RegExp(col, "i"));
});
