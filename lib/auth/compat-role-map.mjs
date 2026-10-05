// Single source of truth for the canonical -> legacy-page compatibility rank.
// Plain .mjs so both the app (canonical-access.ts) and the staging tooling import it.
// Conservative (least-privilege) canonical -> legacy-page mapping.
//  - Station/team operational roles map to their same-rank legacy role.
//  - operation_manager / main_enforcement follow the documented reverse of
//    supabase/PHASE8_ACTIVATION_PLAN.md (legacy MANAGEMENT w/ Operation
//    duties -> operation_manager; legacy ENFORCEMENT -> main_enforcement).
//  - Every other role (international, entity leadership/admin, compliance,
//    caterlink_management, investigation/SAT/profiling unit staff) has NO
//    legacy-page role: they work through the Phase 7 dashboards and the
//    canonical Phase 5-13 RPC workspaces only.
export const COMPAT_ROLE_BY_CANONICAL = {
  aso: "ASO",
  so: "SO",
  sso: "SO",
  dse: "DSE",
  hub_se: "DSE",
  operation_manager: "MANAGEMENT",
  main_enforcement: "ENFORCEMENT",
  airasia_management: null,
  ghod: null,
  global_reporting_controller: null,
  super_admin: null,
  maa_boss: null,
  maa_admin: null,
  aax_boss: null,
  aax_admin: null,
  compliance: null,
  caterlink_management: null,
  investigation_sso: null,
  investigation_so: null,
  investigation_aso: null,
  sat_aso: null,
  profiling_so: null,
  profiling_aso: null,
};

