import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
// @ts-expect-error plain .mjs tooling module
import * as R from "../scripts/staging/apply-bay-board-migration.mjs";

const FILE = `supabase/migrations/${R.MIGRATION.version}_${R.MIGRATION.name}.sql`;
const lf = fs.readFileSync(FILE, "utf8").replace(/\r\n?/g, "\n");
const toCrlf = (s: string) => s.replace(/\n/g, "\r\n");
const toLoneCr = (s: string) => s.replace(/\n/g, "\r");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

test(".gitattributes pins ONLY supabase migrations to LF (no repository-wide renormalization rule)", () => {
  const ga = fs.readFileSync(".gitattributes", "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.deepEqual(ga, ["supabase/migrations/*.sql text eol=lf"]);
});

test("canonicalSql converts CRLF and lone CR to LF in memory, leaves LF alone, and is idempotent", () => {
  assert.equal(R.canonicalSql("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(R.canonicalSql(Buffer.from("x\r\ny")), "x\ny");
  assert.equal(R.canonicalSql(R.canonicalSql("a\r\nb")), "a\nb");
  assert.ok(!/\r/.test(R.canonicalSql(toCrlf(lf))));
});

test("LF, CRLF and lone-CR checkouts of the migration all verify against the SAME frozen hash and return the SAME canonical string", () => {
  for (const variant of [lf, toCrlf(lf), toLoneCr(lf), lf.replace(/\n/, "\r\n")]) {
    const text = R.verifyFrozenMigration(Buffer.from(variant));
    assert.equal(text, lf, "the string that will be executed is the canonical LF text");
    assert.equal(sha(text), R.MIGRATION.sha256, "and it hashes to the frozen SHA-256");
    assert.equal(R.normalisedSha256(Buffer.from(variant)), R.MIGRATION.sha256);
    assert.ok(!/\r/.test(text), "no CR is ever executed");
  }
});

test("the runner parses and executes the exact canonical string it hashed (never the raw bytes)", () => {
  const src = fs.readFileSync("scripts/staging/apply-bay-board-migration.mjs", "utf8");
  assert.match(src, /const text = verifyFrozenMigration\(buf, file\)/);
  assert.match(src, /sql: text/);
  assert.doesNotMatch(src, /buf\.toString\("utf8"\)(?![\s\S]{0,40}canonicalSql)/, "the raw buffer is never turned into executable text outside canonicalSql");
});

test("changed SQL content is rejected, even when only line endings also differ", () => {
  for (const mutate of [(s: string) => `${s}\n-- tampered\n`, (s: string) => s.replace("flight text", "flight text, add column x int"), (s: string) => s.replace("drop not null", "set not null"), () => ""]) {
    assert.throws(() => R.verifyFrozenMigration(Buffer.from(mutate(lf))), /differs from the frozen/);
    assert.throws(() => R.verifyFrozenMigration(Buffer.from(toCrlf(mutate(lf)))), /differs from the frozen/);
  }
});

test("normalization cannot smuggle a change: a CR inside a string literal or dollar-quoted body changes the canonical text, so the frozen hash rejects it", () => {
  const withCrInDollarBody = lf.replace("declare\n", "declare\r\n  -- x\r");
  assert.notEqual(R.canonicalSql(withCrInDollarBody), lf);
  assert.throws(() => R.verifyFrozenMigration(Buffer.from(withCrInDollarBody)), /differs from the frozen/);
  const withCrInLiteral = lf.replace("'arrival'", "'arri\rval'");
  assert.throws(() => R.verifyFrozenMigration(Buffer.from(withCrInLiteral)), /differs from the frozen/);
  // the reviewed migration itself has no CR anywhere in its canonical (committed) form, so normalization changes no literal and no function body
  assert.ok(!/\r/.test(lf));
});

test("the statement allow-list sees identical statements for LF and CRLF input", () => {
  assert.equal(R.statementAudit(R.canonicalSql(toCrlf(lf))), null);
  assert.equal(R.statementAudit(lf), null);
  assert.notEqual(R.statementAudit(R.canonicalSql(toCrlf(`${lf}\ngrant select on public.bay_board to anon;`))), null);
});

test("function fingerprints keep BOTH the raw and the normalized hash; a CRLF-only difference is reported as a deviation, never concealed", () => {
  const props = { securityDefiner: true, config: "{search_path=public}", owner: "postgres", acl: "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", volatility: "s" };
  const lfDef = "CREATE OR REPLACE FUNCTION f()\n AS $function$\nbegin\n return;\nend;\n$function$\n";
  const crlfDef = lfDef.replace(/\n/g, "\r\n");
  const a = R.functionFingerprint({ def: lfDef, ...props });
  const b = R.functionFingerprint({ def: crlfDef, ...props });
  assert.notEqual(a.raw, b.raw);
  assert.equal(a.normalized, b.normalized);
  assert.equal(R.compareFunctionFingerprints(a, a).status, "identical");
  const cmp = R.compareFunctionFingerprints(a, b);
  assert.equal(cmp.status, "semantically-equal-line-endings-differ");
  assert.ok(cmp.deviation && /raw/i.test(cmp.deviation));
  // semantic comparison is allowed ONLY after every security property matches
  for (const [k, v] of [["securityDefiner", false], ["config", "{}"], ["owner", "other"], ["acl", "{=X/postgres}"], ["volatility", "v"]] as const) {
    assert.equal(R.compareFunctionFingerprints(a, R.functionFingerprint({ def: crlfDef, ...props, [k]: v })).status, "different", k);
  }
  assert.equal(R.compareFunctionFingerprints(a, R.functionFingerprint({ def: lfDef.replace("return", "return 1"), ...props })).status, "different");
});

test("a second application is refused now that hosted staging is at 93 (the runner's pre-state is 92)", async () => {
  assert.equal(R.PRE_COUNT, 92);
  assert.equal(R.LAST_PRE, "20261116000001");
  const history = [...Array.from({ length: 92 }, (_, i) => ({ version: String(20261000000000 + i), name: "m" })), { version: "20261117000001", name: "bay_board_sec016_reconciliation" }];
  history[91].version = "20261116000001";
  const client = { query: async (sql: string) => (/schema_migrations order by version/.test(sql) ? { rows: history } : { rows: [] }) };
  await assert.rejects(() => R.execute(client, { files: [{ ...R.MIGRATION, file: "x", sql: lf }], acct: () => "x", live: true, log: () => {}, preCount: R.PRE_COUNT, lastPre: R.LAST_PRE, hashes: R.PRE_STATE }), /history is not exactly 92/);
  const base = fs.readFileSync("scripts/staging/lib/expected-baseline.mjs", "utf8");
  assert.match(base, /EXPECTED_MIGRATION_COUNT = 10[789];/);
});
