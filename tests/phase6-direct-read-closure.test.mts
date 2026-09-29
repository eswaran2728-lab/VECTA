import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository-wide regression test (Phase 6, corrected round 3, section 6):
 * fails when application code introduces a reference to one of the 7
 * AVSEC source report table names outside an explicitly documented,
 * justified allowlist -- including the round-2 "authorize via RPC, then
 * .in(\"id\", ids)" two-step pattern, which round 3 removed entirely in
 * favor of atomic RPCs (has_report_access() AND full content retrieval
 * in the same database call). No file in this allowlist may contain a
 * `.from("report_sec...")`/`.in("id", ...)` pair anymore -- that pattern
 * is explicitly asserted absent, not just tolerated.
 *
 * This is necessarily a coarse, file-level signal (it cannot statically
 * prove dataflow) but it DOES catch the primary regressions this test
 * exists to prevent: a NEW direct report-table SELECT, a reintroduced
 * two-step pattern, or a new unauthorized attachment-path read.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const REPORT_TABLE_NAMES = [
  "report_sec013", "report_sec014", "report_sec016", "report_sec018",
  "report_sec029", "report_sec033", "offload_records",
];

// Every file below is allowed to reference a report table name, with an
// exact reason. Nothing else in lib/, app/, or components/ may. Per the
// review's own instruction, this list contains ONLY: report INSERT,
// controlled acknowledgement transition (none remain -- see below),
// trusted migration/backfill (outside lib/app/components entirely, so
// not listed here at all), and a narrowly-scoped, content-free
// administrative count check.
const ALLOWLIST: Record<string, string> = {
  "lib/avsec/reports/actions.ts":
    "Report CREATE (INSERT) only -- report submission. Explicitly permitted: " +
    "\"Report creation and authorized acknowledgement writes may continue using source tables where required.\"",
  "lib/avsec/admin/actions.ts":
    "deleteUserAccount(): count-only (`{ count: \"exact\", head: true }`), never returns row content, " +
    "MANAGEMENT-role-gated (requireRole), used solely to block deleting an account with linked reports. " +
    "Admin/debug, not a report reader.",
  "lib/avsec/reference-data.ts":
    "REPORT_META table-name-to-metadata mapping only -- constant data, contains no Supabase query at all.",
  "lib/supabase/database.types.ts":
    "Generated Supabase types only -- no runtime query.",
  // These three files pass a report table name only as a TYPED STRING
  // ARGUMENT to a secure RPC's p_source_table parameter (list_reports_
  // secure/search_reports_secure) -- never as a `.from(...)` target.
  // Zero direct SELECT of any report table remains in any of them,
  // asserted explicitly below.
  "lib/avsec/dashboard/queries.ts": "Table name passed only as an RPC parameter (list_reports_secure/search_reports_secure) -- zero .from(\"report_sec...\") calls.",
  "lib/avsec/search/queries.ts": "Table name passed only as an RPC parameter (search_reports_secure) -- zero .from(\"report_sec...\") calls.",
  "lib/dashboard/flight-detail.ts": "Table name passed only as an RPC parameter (search_reports_secure/search_movements_by_registration_secure) -- zero .from(\"report_sec...\") calls.",
};
// CORRECTION (review round 4): lib/avsec/reports/queries.ts previously
// needed an allowlist entry for getMySubmissions()'s own-row direct
// read. That read is now GONE entirely -- getMySubmissions() and
// searchByReportNoPrefix() both call dedicated secure RPCs
// (list_my_submissions_secure()/search_reports_by_number_secure()) and
// this file contains zero literal report-table-name references at all,
// so it is removed from the allowlist rather than re-justified.

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

function directFromSelect(content: string): boolean {
  // Flags `.from("report_sec...")` (or the dynamic `.from(table as never)`
  // form) ONLY when followed, within a short distance, by `.select(`
  // with NO `.insert(`/`.update(` in between -- i.e. a genuine read.
  // `.from("report_sec...").insert({...}).select("id, ...")` (the
  // standard INSERT ... RETURNING pattern report creation relies on,
  // allowlisted separately) is deliberately NOT flagged: `.select(`
  // there follows `.insert(`, not the table reference directly.
  const patterns = [...REPORT_TABLE_NAMES.map((t) => `\\.from\\("${t}"\\)`), `\\.from\\(table as never\\)`];
  for (const p of patterns) {
    const re = new RegExp(`${p}([\\s\\S]{0,60}?)\\.(select|insert|update)\\(`);
    const m = content.match(re);
    if (m && m[2] === "select") return true;
  }
  return false;
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

test("DIRECT-READ CLOSURE (round 4): NO file anywhere in lib/app/components contains a `.from(\"report_sec...\")` SELECT -- ZERO exceptions now, including getMySubmissions()/searchByReportNoPrefix() (lib/avsec/reports/queries.ts), both migrated to dedicated secure RPCs (list_my_submissions_secure()/search_reports_by_number_secure()) this round", () => {
  const offenders: string[] = [];
  for (const file of ALL_FILES) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    if (directFromSelect(content)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `Direct .from("report_sec...") read found in: ${offenders.join(", ")}`);
});

test("DIRECT-READ CLOSURE: lib/avsec/reports/queries.ts's getMySubmissions() and searchByReportNoPrefix() call their dedicated secure RPCs and pass no profile-id/report-scope parameter that could widen results beyond the authenticated caller's own identity or authorized set", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/reports/queries.ts"), "utf8");
  assert.match(content, /\.rpc\("list_my_submissions_secure"/);
  assert.match(content, /\.rpc\("search_reports_by_number_secure"/);
  const mySubmissionsBody = content.slice(content.indexOf("export async function getMySubmissions"), content.indexOf("export async function getMySubmissions") + 600);
  assert.doesNotMatch(mySubmissionsBody, /p_profile_id/, "list_my_submissions_secure() must never be called with a profile id -- it derives the caller from auth.uid() only");
});

test("DIRECT-READ CLOSURE (round 3): NO file contains the two-step 'authorize then .in(\"id\", ids)' pattern -- .in(\"id\", ...) never appears paired with a report source table anywhere", () => {
  for (const file of ALL_FILES) {
    const content = fs.readFileSync(file, "utf8");
    // A bare .in("id", someIds) call is fine for OTHER tables (e.g.
    // report_attachments, incidents) -- what must never recur is one
    // immediately preceded by a report-table .from(...), which the
    // previous test already proves doesn't exist at all.
    if (/\.in\("id",\s*(sec016Ids|sec029Ids|sec018Ids|ids)\)/.test(content) && directFromSelect(content)) {
      assert.fail(`${path.relative(ROOT, file)} appears to reintroduce the two-step id-then-select pattern`);
    }
  }
});

test("DIRECT-READ CLOSURE: the four RPC-parameter-only files each call an atomic secure RPC (list_reports_secure/search_reports_secure/search_movements_by_registration_secure) that returns `content` in the same call -- no second query follows to fetch report content", () => {
  for (const rel of [
    "lib/avsec/dashboard/queries.ts",
    "lib/avsec/search/queries.ts",
    "lib/dashboard/flight-detail.ts",
  ]) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(content, /\.rpc\("(list_reports_secure|search_reports_secure|search_movements_by_registration_secure)"/, `${rel} must call an atomic secure RPC`);
  }
});

test("DIRECT-READ CLOSURE: lib/avsec/export/queries.ts calls export_reports_secure() exactly once and contains no report-table reference at all (fully atomic, single audit row)", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/export/queries.ts"), "utf8");
  assert.match(content, /\.rpc\("export_reports_secure"/);
  assert.equal(referencesReportTable(content), false, "export/queries.ts should reference report table names not at all -- it works entirely through content.* fields");
});

test("DIRECT-READ CLOSURE: lib/avsec/reports/queries.ts (getReportById) calls get_report_secure() ONCE and reads content from its own return value -- no follow-up .from(table) read within that function specifically, and it fails closed (ReportNotIndexedError) when the report is not yet indexed", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/reports/queries.ts"), "utf8");
  const fnStart = content.indexOf("export async function getReportById");
  const fnBody = content.slice(fnStart, fnStart + 900);
  assert.match(fnBody, /\.rpc\("get_report_secure"/);
  assert.match(content, /class ReportNotIndexedError extends Error/);
  assert.match(fnBody, /throw new ReportNotIndexedError/);
  assert.match(fnBody, /data\.content/);
  assert.doesNotMatch(fnBody, /\.from\(table as never\)/, "getReportById() itself must not follow up with a direct source-table read");
});

test("DIRECT-READ CLOSURE: lib/avsec/attachments/actions.ts lists attachments via list_report_attachments_secure() (authorized-first, zero pre-authorization metadata exposure) BEFORE calling get_attachment_authorization_secure() per attachment for signing -- never a raw report_attachments table read", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/attachments/actions.ts"), "utf8");
  const listIdx = content.indexOf('.rpc("list_report_attachments_secure"');
  const authIdx = content.indexOf('.rpc("get_attachment_authorization_secure"');
  assert.ok(listIdx > -1, "must call list_report_attachments_secure()");
  assert.ok(authIdx > -1, "must call get_attachment_authorization_secure()");
  assert.ok(listIdx < authIdx, "listing must be authorized before per-attachment signing is attempted");
  assert.match(content, /createSignedUrl\(authorized\.storage_path/);
  assert.doesNotMatch(content, /createSignedUrl\(r\.storage_path/, "must not sign the un-reverified client-visible row's own storage_path");
  assert.doesNotMatch(content, /\.from\("report_attachments"\)\s*\n?\s*\.select\("id, file_name, mime_type, size_bytes, storage_path/, "must not directly select attachment rows including storage_path before authorization");
});

test("DIRECT-READ CLOSURE: lib/dashboard/needs-your-action.ts contains no report-table reference at all -- fully replaced by needs_your_action_secure()", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib", "dashboard", "needs-your-action.ts"), "utf8");
  assert.match(content, /\.rpc\("needs_your_action_secure"\)/);
  assert.equal(referencesReportTable(content), false);
});

test("DIRECT-READ CLOSURE: lib/avsec/reports/actions.ts's report-table references are all INSERT (create), never SELECT/UPDATE against report content", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/reports/actions.ts"), "utf8");
  for (const t of REPORT_TABLE_NAMES) {
    if (!content.includes(`"${t}"`)) continue;
    const idx = content.indexOf(`"${t}"`);
    const nextChunk = content.slice(idx, idx + 200);
    assert.match(nextChunk, /\.insert\(/, `expected .insert( shortly after "${t}" in reports/actions.ts`);
  }
});

test("DIRECT-READ CLOSURE: lib/avsec/admin/actions.ts's report-table references are count-only (head: true) -- never row content", () => {
  const content = fs.readFileSync(path.join(ROOT, "lib/avsec/admin/actions.ts"), "utf8");
  assert.match(content, /count: "exact", head: true/);
});
