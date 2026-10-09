/**
 * Who may open the announcement-management page and what scope they see, derived from canonical role codes only.
 * Display/guard layer: the *_announcement_secure RPCs (can_user_publish_announcement / can_user_manage_announcement) decide every
 * write and the audited acknowledgement report in the database.
 *
 *   GHOD                                   -> manages the GLOBAL channel only
 *   maa_boss / maa_admin / aax_boss / aax_admin -> manage the MALAYSIA AOC channel only
 *   airasia_management                     -> read-only
 *   everyone else                          -> no access to the management page
 */
export interface AnnouncementCapabilities {
  mode: "manage" | "read_only" | "none";
  canManageGlobal: boolean;
  canManageMalaysia: boolean;
}

const MALAYSIA_PUBLISHERS = ["maa_boss", "maa_admin", "aax_boss", "aax_admin"];

export function announcementCapabilities(roleCodes: readonly string[]): AnnouncementCapabilities {
  const canManageGlobal = roleCodes.includes("ghod");
  const canManageMalaysia = roleCodes.some((c) => MALAYSIA_PUBLISHERS.includes(c));
  if (canManageGlobal || canManageMalaysia) return { mode: "manage", canManageGlobal, canManageMalaysia };
  if (roleCodes.includes("airasia_management")) return { mode: "read_only", canManageGlobal: false, canManageMalaysia: false };
  return { mode: "none", canManageGlobal: false, canManageMalaysia: false };
}
