import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 13 closure test: every page.tsx must have SOME server-side
 * authorization gate, or be explicitly allowlisted as intentionally
 * public. This encodes the Phase 13 route-closure audit
 * (docs/phase13/route-navigation-closure.md) as a standing guard --
 * if a new page is added later with none of the known gate patterns,
 * this test fails and names the file, rather than the gap going
 * unnoticed until a manual review happens to catch it.
 *
 * This is a static source scan, not a live HTTP test -- it proves a gate
 * is PRESENT in the file, not that it is correct. Correctness of each
 * existing gate was reviewed manually for this phase (see the audit doc);
 * this test's job is only to stop a new, ungated page from slipping in
 * silently.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "app");

// Every one of these substrings, if present anywhere in the file,
// counts as "has a server-side gate" for this check.
const GATE_MARKERS = [
  "requireRole(",
  "requireRouteAccess(",
  "requireProfile(",
  "requirePhase8Role(",
  "isSuperAdmin(",
  "redirect(\"/login\")",
  "redirect('/login')",
  "supabase.auth.updateUser(", // Supabase Auth's own session requirement is the gate
];

// Pages confirmed public by design (docs/phase13/route-navigation-closure.md).
// Paths are relative to app/, using forward slashes.
const PUBLIC_ALLOWLIST = new Set([
  "page.tsx", // app/page.tsx -- landing page
  "login/page.tsx",
  "register/page.tsx",
  "forgot-password/page.tsx",
  "reset-password/page.tsx",
  "(avsec)/avsec/pending-approval/page.tsx", // checks its own session+status, redirects accordingly
  "(avsec)/avsec/reports/offload/page.tsx", // pure redirect to /avsec/reports/sec016, which is itself gated
]);

function listPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listPageFiles(full));
    } else if (entry.name === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}

test("Phase 13 route closure: every non-ICMS, non-public page.tsx has a recognized server-side auth gate", () => {
  if (!fs.existsSync(APP_DIR)) {
    throw new Error("app/ directory not found -- test environment is wrong");
  }

  const offenders: string[] = [];
  const pages = listPageFiles(APP_DIR);
  assert.ok(pages.length > 50, "sanity check: expected dozens of page.tsx files under app/");

  for (const fullPath of pages) {
    const relativeToApp = path.relative(APP_DIR, fullPath).split(path.sep).join("/");

    // ICMS is a separate module with its own auth helper (lib/icms/auth.ts)
    // and is explicitly out of scope for this Malaysia-upgrade audit.
    if (relativeToApp.startsWith("(icms)/")) continue;

    if (PUBLIC_ALLOWLIST.has(relativeToApp)) continue;

    const content = fs.readFileSync(fullPath, "utf8");
    const hasGate = GATE_MARKERS.some((marker) => content.includes(marker));

    // scan/page.tsx has its own inline session+profile check rather than a
    // shared helper -- recognized by name per the audit doc, not a generic
    // marker (its exact wording is too specific to make into a reusable
    // substring without being fragile).
    const isKnownInlineGate = relativeToApp === "(avsec)/avsec/scan/page.tsx" && content.includes('redirect("/login")');

    if (!hasGate && !isKnownInlineGate) {
      offenders.push(relativeToApp);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The following page(s) have no recognized auth gate and are not in the public allowlist -- add a gate, or add them to PUBLIC_ALLOWLIST in this test with a documented reason: ${offenders.join(", ")}`
  );
});
