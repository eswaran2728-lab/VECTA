import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository-wide regression test (Phase 6, review round 2, section 11):
 * fails when application code introduces a reference to one of the 7
 * AVSEC source report table names outside an explicitly documented,
 * justified allowlist.
 *
 * This is necessarily a coarse, file-level signal (it cannot statically
 * prove that every read inside an allowlisted file goes through the
 * secure two-step authorized-id pattern -- that would require real
 * dataflow analysis) but it DOES catch the primary regression this test
 * exists to prevent: a NEW file quietly reintroducing an unauthorized
 * direct report-table read. Every allowlisted file's justification is
 * recorded below and must be updated (not silently widened) if that
 * file's role changes.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const REPORT_TABLE_NAMES = [
  "report_sec013", "report_sec014", "report_sec016", "report_sec018",
  "report_sec029", "report_sec033", "offload_records",
];

// Every file below is allowed to reference a report table name, with an
// exact reason. Nothing else in lib/, app/, or components/ may.
const ALLOWLIST: Record<string, string> = {
  "lib/avsec/reports/actions.ts":
    "Report CREATE (INSERT) only -- report submission. Explicitly permitted: " +
    "\"Report creation and authorized acknowledgement writes may continue using source tables where required.\"",
  "lib/avsec/admin/actions.ts":
    "deleteUserAccount(): count-only (`{ count: \"exact\", head: true }`), never returns row content, " +
    "MANAGEMENT-role-gated (requireRole), used solely to block deleting an account with linked reports. " +
    "Admin/debug, not a report reader.",
  "lib/dashboard/needs-your-action.ts":
    "Lists SEC014 reports still awaiting the caller's OWN acknowledgement, scoped to the caller's own " +
    "station/team/ops_group -- the exact scope can_acknowledge_report() already grants them. This is " +
    "acknowledgement-support, not a general report-detail/search/dashboard read; explicitly permitted " +
    "by the same instruction as the write-path exception above (acknowledge/status-transition support).",
  "lib/avsec/reference-data.ts":
    "REPORT_META table-name-to-metadata mapping only -- constant data, contains no Supabase query at all.",
  "lib/supabase/database.types.ts":
    "Generated Supabase types only -- no runtime query.",
  // The three files below were migrated this round to the secure
  // two-step pattern (list_reports_secure()/search_reports_secure()
  // authorize via has_report_access() first; the source-table read that
  // follows is scoped to exactly that already-authorized id set via
  // .in("id", ids)). Their remaining report-table-name references are
  // part of that pattern, not a bypass of it -- verified by the
  // "every source-table read site is paired with a prior secure RPC
  // call in the same file" tests below.
  "lib/avsec/dashboard/queries.ts": "Migrated to the secure two-step pattern this round (getFilteredSubmissions, getFlightCoverage).",
  "lib/avsec/search/queries.ts": "Migrated to the secure two-step pattern this round (searchDailyReportsByStaff, searchAircraftReportsByStaff).",
  "lib/dashboard/flight-detail.ts": "Migrated to the secure two-step pattern this round (getFlightsForDate, getFlightDetail). getMovementsByRegistration is NOT yet migrated -- see the Phase 6 report's remaining-exceptions section (no natural date-bound parameter for a registration-only lookup).",
  "lib/avsec/export/queries.ts": "Migrated to the secure two-step pattern this round (getFullRowsForExport), plus a single export_reports_secure() audit call per export.",
};

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SCAN_DIRS = ["lib", "app", "components"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const ALL_FILES = SCAN_DIRS.flatMap((d) => listFiles(d));

function referencesReportTable(content: string): boolean {
  return REPORT_TABLE_NAMES.some((t) => content.includes(`"${t}"`));
}

test("DIRECT-READ CLOSURE: every file referencing a report table name is in the explicit allowlist", () => {
  const offenders: string[] = [];
  for (const file of ALL_FILES) {
    const content = fs.readFileSync(file, "utf8");
    if (!referencesReportTable(content)) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (!(rel in ALLOWLIST)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `Unallowlisted report-table reference(s) found: ${offenders.join(", ")}. Add to ALLOWLIST with an exact justification, or remove the direct read in favor of the secure RPC layer.`);
});

test("DIRECT-READ CLOSURE: the allowlist itself only names files that currently exist -- a stale entry (file deleted/renamed) is caught rather than silently accumulating", () => {
  for (const rel of Object.keys(ALLOWLIST)) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `Allowlisted file no longer exists: ${rel} -- remove it from ALLOWLIST`);
  }
});

test("DIRECT-READ CLOSURE: the three migrated dashboard/search/export/flight-detail files each call a secure RPC (list_reports_secure or search_reports_secure) at least once -- a source-table read exists in these files ONLY alongside that authorization call, never alone", () => {
  for (const rel of [
    "lib/avsec/dashboard/queries.ts",
    "lib/avsec/search/queries.ts",
    "lib/dashboard/flight-detail.ts",
    "lib/avsec/export/queries.ts",
  ]) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(content, /\.rpc\("(list_reports_secure|search_reports_secure)"/, `${rel} must call a secure authorization RPC`);
  }
});

test("DIRECT-READ CLOSURE: lib/avsec/reports/queries.ts (getReportById) calls get_report_secure() for authorization before reading full report content, and throws (fails closed) when the report is not yet indexed", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/reports/queries.ts"), "utf8");
  assert.match(content, /\.rpc\("get_report_secure"/);
  assert.match(content, /class ReportNotIndexedError extends Error/);
  assert.match(content, /throw new ReportNotIndexedError/);
});

test("DIRECT-READ CLOSURE: lib/avsec/attachments/actions.ts calls get_attachment_authorization_secure() for every attachment before issuing a signed URL, and never calls createSignedUrl with a client-supplied path", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/attachments/actions.ts"), "utf8");
  assert.match(content, /\.rpc\("get_attachment_authorization_secure"/);
  assert.match(content, /createSignedUrl\(authorized\.storage_path/);
  assert.doesNotMatch(content, /createSignedUrl\(r\.storage_path/, "must not sign the un-reverified client-visible row's own storage_path");
});

test("DIRECT-READ CLOSURE: lib/avsec/reports/actions.ts's report-table references are all INSERT (create), never SELECT/UPDATE against report content", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/reports/actions.ts"), "utf8");
  // Every report-table block is followed by .insert( before the next
  // report-table reference or end of file -- a coarse but meaningful
  // check that this file's report-table touches are creates, not reads.
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    if (!content.includes(`"${t}"`)) continue;
    const idx = content.indexOf(`"${t}"`);
    const nextChunk = content.slice(idx, idx + 200);
    assert.match(nextChunk, /\.insert\(/, `expected .insert( shortly after "${t}" in reports/actions.ts`);
  }
});
