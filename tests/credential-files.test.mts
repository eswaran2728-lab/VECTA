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
  { label: "aso", display: "ASO PEN", roleCode: "aso", accountState: "approved", scope: { aoc: "MY", entity: "MAA", station: "PEN", team: "team A" }, email: "aso.pen@vecta.test", password: "PW-PLACEHOLDER-xyz", expectedWorkspace: "/avsec/home (ASO)", kind: "station_variant" },
  { label: "neg-pending-profile", display: "Pending", roleCode: "aso", accountState: "pending", scope: {}, email: "pending.profile@vecta.test", password: "PW-PLACEHOLDER-xyz", expectedWorkspace: "/avsec/pending-approval", kind: "negative" },
];

test("the plain-text copy uses the requested block layout: URL, then ROLE / EMAIL / PASSWORD / EXPECTED ACCESS / EXPECTED STATE per account", () => {
  const t = renderCredentialText({ url: "https://preview.example.test", password: "PW-PLACEHOLDER-xyz", accounts });
  const lines = t.split("\n");
  assert.equal(lines[0], "VECTA STAGING");
  assert.equal(lines[1], "URL: https://preview.example.test");
  assert.equal(lines[2], "");
  assert.deepEqual(lines.slice(3, 8).map((l) => l.split(":")[0]), ["ROLE", "EMAIL", "PASSWORD", "EXPECTED ACCESS", "EXPECTED STATE"]);
  assert.equal(lines[3], "ROLE: ASO PEN");
  assert.equal(lines[4], "EMAIL: aso.pen@vecta.test");
  assert.equal(lines[5], "PASSWORD: PW-PLACEHOLDER-xyz");
  assert.match(lines[6], /\/avsec\/home/);
  assert.match(lines[6], /MY \/ MAA \/ PEN/, "scope is included");
  assert.equal(lines[7], "EXPECTED STATE: approved");
  assert.match(t, /EXPECTED STATE: pending/);
  assert.equal(t.split("\n").filter((l) => l.startsWith("EMAIL: ")).length, accounts.length);
});

test("expectations: positives name the landing page, negatives state that access is denied or restricted", () => {
  assert.match(accountExpectation(accounts[0]), /\/avsec\/home/);
  assert.match(accountExpectation(accounts[1]), /pending-approval/);
  assert.match(accountExpectation(accounts[1]), /no functional access/i);
});

test("the PDF source marks the document confidential, includes every account and escapes HTML in values", () => {
  const html = renderCredentialHtml({ url: "https://preview.example.test", generatedAt: "2026-10-22 18:30 MYT", password: "PW-PLACEHOLDER-xyz", accounts: [{ ...accounts[0], display: "<script>x</script>" }, accounts[1]] });
  assert.match(html, /CONFIDENTIAL/);
  assert.match(html, /aso\.pen@vecta\.test/);
  assert.match(html, /pending\.profile@vecta\.test/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Generated \(Malaysia time\)/);
  for (const col of ["Role", "Role code", "Email", "Scope", "Landing", "State"]) assert.match(html, new RegExp(col, "i"));
});
