-- =======================================================================
-- CaterLink-only identities hold no VECTA workspace.
--
-- canon_is_active() gates every VECTA reference read (stations, teams, shifts, aircraft types, knowledge base ...)
-- and the "own insert" policies of VECTA records. It returned true for ANY active assignment, so a CaterLink
-- Management account (role caterlink_management, CaterLink-only) could read VECTA reference rows. It now counts only
-- assignments other than caterlink_management, so a CaterLink-only identity gets no VECTA reference or own-record
-- access. Every other role is unaffected; CaterLink's own data keeps its dedicated canonical policies.
-- (Function signature, owner, search_path and EXECUTE grants are unchanged: CREATE OR REPLACE preserves the ACL.)
-- =======================================================================
create or replace function public.canon_is_active()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.canon_assignments() a where a.role_code <> 'caterlink_management'
  );
$function$;
