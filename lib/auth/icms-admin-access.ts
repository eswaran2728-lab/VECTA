// Canonical role codes behind the ICMS "supervisor" administration surface
// (users/audit/archive/whitelist/incident review). Kept outside lib/icms so the
// Phase 3 contract holds that CaterLink Management's role code is referenced
// only by the whitelist administration module there: these are ADMINISTRATION
// capabilities, never checkpoint scan/completion authority.
export const ICMS_ADMIN_CODES = ["caterlink_management"] as const;
export const ICMS_REVIEW_CODES = ["caterlink_management", "main_enforcement", "operation_manager"] as const;
export const ICMS_ARCHIVE_CODES = ["caterlink_management", "operation_manager"] as const;
