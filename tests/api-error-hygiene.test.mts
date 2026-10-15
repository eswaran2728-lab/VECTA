import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** API routes must never return an exception's own message (it can carry SQL, table names, file paths or upstream detail). */
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /^route\.tsx?$/.test(e.name) ? [p] : [];
  });

test("no API route returns a raw exception message to the caller", () => {
  const offenders: string[] = [];
  for (const f of walk("app/api")) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    if (/(error|err|e)\s+instanceof\s+Error\s*\?\s*(error|err|e)\.message/.test(src)) offenders.push(f);
    if (/NextResponse\.json\(\s*\{\s*error:\s*(error|err|e)\.message/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
