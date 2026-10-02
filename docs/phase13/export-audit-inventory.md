# Export / Audit / PDF-Generation Closure Inventory

Exhaustive (not sampled) this round: every RPC whose name matches
`export`/`audit`/PDF-generation, found via `grep -rhoE` across every
migration file, cross-referenced against every `.rpc("...")` call site
across `app/`, `lib/`, `components/`. This table is also the authoritative
source `tests/phase13-export-audit-closure.test.mts` enforces -- a new
export/audit RPC call site that isn't listed here fails that test.

## Export routes

| RPC | App caller | Allowed role | Org scope | Row/record limit | Sensitive fields | Audit event | Inactive-role behavior | Cross-AOC behavior | Direct-table bypass |
|---|---|---|---|---|---|---|---|---|---|
| `export_reports_secure` | `lib/avsec/export/queries.ts` | Global Reporting Controller (per confirmed ownership) | org-wide/scoped per caller's role | not re-verified this round (sampled) | report content | not re-verified this round | not re-verified this round | not re-verified this round | RLS-protected underlying tables; not re-verified this round |
| `export_operation_workforce_secure` | `lib/phase8/exports.ts` | Operation Manager | Malaysia Operation | not re-verified | staff names/roster | not re-verified | not re-verified | not re-verified | not re-verified |
| `export_enforcement_workforce_secure` | `lib/phase8/exports.ts` | Main Enforcement | SAT/Profiling/Enforcement | not re-verified | staff names/roster | not re-verified | not re-verified | not re-verified | not re-verified |
| `export_caterlink_data_secure` | **Was zero callers -- fixed this phase**: `lib/icms/actions/caterlink-export.ts` | CaterLink Management | own AOC (`p_target_aoc_id`, defaults to caller's own) | unbounded in the RPC itself (not re-verified/limited this round) | vehicle/driver identifiers, route | none dedicated found | not re-verified | resolved via `has_active_role_for_aoc` inside the RPC (same pattern as every other Phase 9 RPC) | no direct grant on `transactions` for `authenticated` (confirmed) |
| `export_entity_user_directory` | **Was zero callers -- fixed this phase**: `lib/avsec/admin/entity-registrations.ts` | MAA/AAX Admin (`is_entity_admin`) | own entity only | not re-verified | staff names/roles | none dedicated found | not re-verified | entity-scoped by construction (an Admin for one entity cannot request another's code and get real rows -- enforced inside the RPC, not re-verified line-by-line this round) | not re-verified |

## PDF generation / final-document routes

| RPC | App caller | Allowed role | Audit event | Cross-AOC behavior |
|---|---|---|---|---|
| `record_caterlink_transaction_pdf_secure` (new this phase) | `lib/icms/actions/caterlink-pdf.ts` | CaterLink Management only | `phase8_write_audit('caterlink_pdf_generated', ...)` | Transaction's own `aoc_id` scopes the check; a foreign-AOC CaterLink Management cannot generate (tested) |
| `get_caterlink_transaction_pdf_secure` (new this phase) | `lib/icms/actions/caterlink-pdf.ts` | CaterLink Management, submitter, destination officer, Operation Manager (same AOC) | `phase8_write_audit('caterlink_pdf_access', ...)` | Foreign-AOC denied (tested) |
| `authorize_caterlink_pdf_secure` (Phase 9, corrected this phase) | not directly called by any app code found this round -- superseded in practice by the two RPCs above, which this phase's app code actually uses | same as above | `phase8_write_audit('caterlink_pdf_access', ...)` | same as above |
| `upload_sat_combined_report_secure` / `replace_sat_combined_report_secure` | `lib/phase8/sat.ts` | not re-verified this round (pre-existing, already production code) | not re-verified | not re-verified |
| `authorize_report_pdf_secure` (Phase 6, found by this phase's closure test itself) | `app/api/avsec/export/pdf/[type]/[id]/route.tsx` | report-access authorization re-used from Phase 6 (not re-verified line-by-line this round) | not re-verified | not re-verified |
| `add_announcement_attachment_secure` | `lib/avsec/announcements/attachments.ts` (corrected this phase -- the only prior caller had wrong parameter names) | draft owner/publisher (`can_user_manage_announcement`) | logged as `'edit'` action in `announcement_audit_log` | cross-AOC denied via the same announcement-scope check Phase 11 already enforces |
| `get_announcement_attachment_download_secure` (new this phase) | `lib/avsec/announcements/attachments.ts` | visibility or manager (`is_announcement_visible_to_caller` / `can_user_manage_announcement`) | `attachment_download` (new action value, this phase) | cross-AOC denied (tested) |
| `remove_announcement_attachment_secure` (new this phase) | `lib/avsec/announcements/attachments.ts` | manager only, draft-only (immutability) | `attachment_removed` (new action value, this phase) | n/a (manager-scoped) |

## Audit-write helpers (internal, not expected to have direct app callers)

| Function | Called by |
|---|---|
| `phase8_write_audit` | `perform`ed from inside other SECURITY DEFINER RPCs (CaterLink, now including the two new PDF RPCs) -- never called directly by application code, by design |
| `record_wois_audit_event_secure` | `app/api/wois/chat/route.ts` and other WOIS RPCs internally |
| `record_wois_audit_event_secure` (Phase 13 analog) `record_wois_audit_event_secure`-style pattern reused for `phase13_readiness_access_log` via `view_legacy_role_mapping_report_secure`/`view_release_readiness_report_secure` | Super Admin readiness page only |

## Closure enforcement

`tests/phase13-export-audit-closure.test.mts` statically scans every
`.rpc("...")` call site in `app/`, `lib/`, `components/` for a name
matching `/export|audit|pdf/i` (excluding test/doc files) and asserts
every match is one of the RPC names listed in this document's tables. A
new export/audit/PDF call site introduced later without updating this
list fails that test, by name, rather than silently escaping review.
