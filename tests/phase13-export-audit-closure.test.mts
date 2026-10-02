import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 13 closure test: every export/audit/PDF-generation RPC call site
 * in the application must be named in the authoritative inventory
 * (docs/phase13/export-audit-inventory.md). A new call site introduced
 * later without being added to the allowlist below (and to that
 * document) fails this test by name, rather than silently escaping
 * review -- this is the standing guard the Phase 13 correction requires.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Exactly the RPC names listed in docs/phase13/export-audit-inventory.md.
const ALLOWED_EXPORT_AUDIT_RPCS = new Set([
  "export_reports_secure",
  "export_operation_workforce_secure",
  "export_enforcement_workforce_secure",
  "export_caterlink_data_secure",
  "export_entity_user_directory",
  "record_caterlink_transaction_pdf_secure",
  "get_caterlink_transaction_pdf_secure",
  "authorize_caterlink_pdf_secure",
  "upload_sat_combined_report_secure",
  "replace_sat_combined_report_secure",
  "authorize_report_pdf_secure",
  "add_announcement_attachment_secure",
  "get_announcement_attachment_download_secure",
  "remove_announcement_attachment_secure",
  "record_wois_audit_event_secure",
  "view_release_readiness_report_secure",
  "view_legacy_role_mapping_report_secure",
]);

const RPC_CALL_PATTERN = /\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g;
const NAME_FILTER = /export|audit|pdf/i;

function listFilesRecursive(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

test("Phase 13 export/audit/PDF closure: every matching .rpc() call site is in the authoritative inventory", () => {
  const dirs = ["app", "lib", "components"].map((d) => path.join(REPO_ROOT, d));
  const offenders: string[] = [];
  let totalMatches = 0;

  for (const dir of dirs) {
    for (const file of listFilesRecursive(dir, [".ts", ".tsx"])) {
      const content = fs.readFileSync(file, "utf8");
      for (const match of content.matchAll(RPC_CALL_PATTERN)) {
        const rpcName = match[1];
        if (!NAME_FILTER.test(rpcName)) continue;
        totalMatches += 1;
        if (!ALLOWED_EXPORT_AUDIT_RPCS.has(rpcName)) {
          offenders.push(`${rpcName} (${path.relative(REPO_ROOT, file)})`);
        }
      }
    }
  }

  assert.ok(totalMatches > 0, "sanity check: expected to find at least one export/audit/pdf RPC call site");
  assert.deepEqual(
    offenders,
    [],
    `The following export/audit/pdf RPC call site(s) are not in the authoritative inventory (docs/phase13/export-audit-inventory.md) -- add them there and to ALLOWED_EXPORT_AUDIT_RPCS in this test: ${offenders.join(", ")}`
  );
});
