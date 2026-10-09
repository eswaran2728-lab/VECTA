/** Pure derivation of the caller's entity-leadership identity from canonical role codes (unit-testable, no framework imports). */
export interface EntityLeadership {
  /** The operating entity code of the (first) leadership role. */
  entityCode: "MAA" | "AAX";
  isBoss: boolean;
  isAdmin: boolean;
}

export function entityLeadershipFromRoleCodes(roleCodes: readonly string[]): EntityLeadership | null {
  const hasMaa = roleCodes.some((c) => c === "maa_boss" || c === "maa_admin");
  const hasAax = roleCodes.some((c) => c === "aax_boss" || c === "aax_admin");
  if (!hasMaa && !hasAax) return null;
  const entityCode = hasMaa ? "MAA" : "AAX";
  const prefix = entityCode.toLowerCase();
  return {
    entityCode,
    isBoss: roleCodes.includes(`${prefix}_boss`),
    isAdmin: roleCodes.includes(`${prefix}_admin`),
  };
}
