import "server-only";

import type { Role } from "./database.types";

/**
 * Maps an AVSEC-native `profiles.role` value to its ICMS-side shadow
 * `users.role` value. Every account that lives in `public.profiles`
 * (AVSEC-origin) needs a matching `public.users` row (same id) so ICMS's
 * own access control (lib/icms/auth.ts requireProfile(), keyed off a row
 * in public.users) recognizes it — this is the single source of truth for
 * that mapping, shared between the one-time backfill
 * (supabase/migrations/backfill_icms_shadow_users.sql, which restates the
 * same rules in raw SQL — keep the two in sync) and the live
 * account-creation code path (lib/avsec/admin/actions.ts createStaffAccount).
 *
 * - ADMIN -> supervisor (ICMS's own admin-equivalent role; established
 *   convention from supabase/migrations/grant_icms_access_to_admin_enforcement.sql).
 * - ENFORCEMENT -> enforcement (direct match).
 * - MANAGEMENT -> management (new ICMS role value, given full read/
 *   incident-resolution parity with enforcement — see
 *   supabase/migrations/management_icms_parity.sql).
 * - SO / ASO / DSE -> ops_staff. JUDGMENT CALL made in the project
 *   owner's absence, flagged for their review: no existing ICMS role
 *   represents generic patrol staff (only checkpoint-specific roles like
 *   post2_avsec, or elevated roles like supervisor/enforcement/management)
 *   — a checkpoint role would over-grant that checkpoint's permissions,
 *   an elevated role would over-grant org-wide visibility. 'ops_staff' is
 *   a new, minimal role that carries no elevated or checkpoint-specific
 *   ICMS permission (no RLS policy anywhere lists it) — it exists only so
 *   requireProfile() finds a row and the ops_group-scoped Scan check
 *   (which reads `ops_group` directly, independent of this `role` column)
 *   works.
 */
export function mapAvsecRoleToIcmsRole(avsecRole: string): Role {
  switch (avsecRole) {
    case "ADMIN":
      return "supervisor";
    case "ENFORCEMENT":
      return "enforcement";
    case "MANAGEMENT":
      return "management";
    case "SO":
    case "ASO":
    case "DSE":
    default:
      return "ops_staff";
  }
}

/**
 * Mirrors supabase/migrations/unified_role_model.sql's ADMIN/ENFORCEMENT/
 * MANAGEMENT/SO/ASO/DSE -> unified_role mapping. Derived directly from the
 * AVSEC role rather than read back off profiles.unified_role, since
 * createStaffAccount doesn't set that column on the profiles row it
 * inserts — this keeps the shadow row's unified_role correct regardless.
 */
export function mapAvsecRoleToUnifiedRole(avsecRole: string): string {
  switch (avsecRole) {
    case "ADMIN":
      return "admin";
    case "ENFORCEMENT":
      return "enforcement";
    case "MANAGEMENT":
      return "management";
    case "SO":
      return "so";
    case "ASO":
      return "aso";
    case "DSE":
      return "dse";
    default:
      return avsecRole.toLowerCase();
  }
}

export interface AvsecProfileForShadow {
  id: string;
  name: string;
  email: string;
  role: string;
  staff_no: string | null;
  ops_group: string | null;
}

/** Builds the public.users row to insert for a given AVSEC profile. */
export function buildShadowUserRow(profile: AvsecProfileForShadow) {
  return {
    id: profile.id,
    name: profile.name,
    staff_id: profile.staff_no && profile.staff_no.trim() ? profile.staff_no.trim() : `AVSEC-${profile.id.slice(0, 8)}`,
    email: profile.email,
    role: mapAvsecRoleToIcmsRole(profile.role),
    status: "active",
    preferred_language: "en",
    unified_role: mapAvsecRoleToUnifiedRole(profile.role),
    ops_group: profile.ops_group,
    duty_post: null,
  };
}
