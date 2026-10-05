// Missing legacy ICMS data modules (tables that do not exist on this environment) must render a
// safe "not activated / no data available" state: never a crash, and never a misleading
// "unauthorised" redirect for a properly authorised canonical user.
export interface QueryErrorLike {
  code?: string | null;
  message?: string | null;
}

export function isModuleMissing(error: QueryErrorLike | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "PGRST205" || code === "42P01" || code === "PGRST200") return true;
  return /could not find the table|relation .* does not exist|could not find a relationship/i.test(error.message ?? "");
}
