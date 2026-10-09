import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { entityLeadershipFromRoleCodes, type EntityLeadership } from "@/lib/dashboard/entity-leadership-roles";

/**
 * Page guard for the MAA/AAX leadership pages. It reads the caller's ACTIVE canonical role codes only (never profiles.role or a
 * legacy column). It is a convenience layer: every RPC these pages call re-checks the same decision in the database, so a stale or
 * forged client state can never widen access.
 */
export async function requireEntityLeadership(kind: "any" | "boss" | "admin" = "any"): Promise<{ profileId: string; leadership: EntityLeadership }> {
  const profile = await requireProfile();
  const access = profile.canonical as CanonicalAccess;
  const leadership = entityLeadershipFromRoleCodes(access.roleCodes);
  const allowed = leadership !== null && (kind === "any" || (kind === "boss" && leadership.isBoss) || (kind === "admin" && leadership.isAdmin));
  if (!allowed) redirect("/avsec/my-dashboard");
  return { profileId: profile.id, leadership };
}
