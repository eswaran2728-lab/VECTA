import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Part B browser flow selects the actual seal colour button and waits for the approved redirect", () => {
  const script = fs.readFileSync("scripts/staging/e2e-external-workflows.mjs", "utf8");
  const partB = script.slice(script.indexOf("// ---- origin action"), script.indexOf("await page.goto(`${base}/avsec/caterlink/receipt`"));
  assert.match(partB, /getByRole\("button", \{ name: "Blue" \}\)\.click\(\)/);
  assert.doesNotMatch(partB, /colorSel\.selectOption/);
  assert.match(partB, /approved=1/);
  assert.doesNotMatch(partB, /\/INFLIGHT\|approved\/i\.test\(bBody\)/);
  assert.doesNotMatch(partB, /&& !bAlert/);
  assert.match(partB, /waitForFunction\(\(\) =>/);
  assert.match(partB, /getByRole\("button", \{ name: "Find" \}\)\.click\(\)/);
});

test("receipt and PDF checks use the completed state and include completed jobs", () => {
  const script = fs.readFileSync("scripts/staging/e2e-external-workflows.mjs", "utf8");
  assert.doesNotMatch(script, /gone && !\/not authori/);
  assert.match(script, /icms\/admin\/final-pdfs\?all=1/);
  assert.doesNotMatch(script, /\/Completed\/i\.test\(t\)/);
});
