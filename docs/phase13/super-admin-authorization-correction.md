# Phase 13 Super Admin authorization correction

## Defect
The pending Phase 13 migrations authorised Super Admin from legacy profile columns
(`profiles.unified_role = 'super_admin'` or `profiles.role::text = 'SUPER_ADMIN'`).
The staging baseline has no `profiles.unified_role`, so the first readiness migration failed and
rolled back (staging stayed at 57 recorded migrations). `SUPER_ADMIN` is not a canonical legacy
profile role either.

## Canonical authority
An active Phase 3 `super_admin` role assignment. Helper reused (no new helper needed):
`public.has_active_role('super_admin')` -> `public.has_role_in_scope('super_admin')`
(Phase 3, `20260928000002`). Verified semantics:

| Requirement | Enforced |
|---|---|
| identity from `auth.uid()` (no profile-id parameter) | yes |
| approved profile (`profiles.status = 'approved'`) | yes |
| active role definition (`role_definitions.is_active`) | yes |
| role code `super_admin` | yes |
| non-revoked (`revoked_at is null`) | yes |
| effective window (`starts_at <= now()`, `ends_at` null or future) | yes |
| no operational scope required | yes - scope args optional and unchecked |
| no entity membership required | yes - never consulted; Phase 3/4 triggers forbid it for protected global roles |
| anon / service_role / postgres bypass | none - `auth.uid()` null means denied |

## Corrected locations
- `get_legacy_role_mapping_report_secure` (readiness migration)
- `get_release_readiness_report_secure` (readiness migration)
- `phase13_readiness_access_log` RLS policy (readiness migration)
- `get_release_readiness_report_secure` redefinition (storage/admin migration)
- `app/super-admin/readiness/page.tsx` -> new `hasActiveSuperAdminRole()` in `lib/super-admin/actions.ts`
- `lib/supabase/middleware.ts`: `/super-admin/readiness` gated on the canonical RPC before the legacy profile lookup (`isReadinessPath` in `middleware-gate-logic.ts`)

## Related Phase 13 runtime dependency also corrected
Phase 13's `approve_registration_request` calls `apply_compatibility_profile_fields()`. The Phase 4
version writes `profiles.unified_role` and `approved_by/approved_at/rejection_reason`; none exist on the
staging baseline, so every KUL dse/so/aso approval would fail at runtime. The storage/admin migration now
re-declares the helper (same signature, grants and audit row) writing those legacy columns only where they exist.

## Unrelated legacy gates found - documented, NOT changed
- `isSuperAdmin()` (`lib/super-admin/actions.ts`) still reads `profiles/users.unified_role` and `role`; used by
  the other `/super-admin` pages and organisation actions.
- `lib/supabase/middleware.ts` selects `unified_role` for all other gated routes (`/avsec`, `/icms`,
  `/caterlink`, `/super-admin`) and the post-login redirect. Where the column is absent the lookup returns no
  profile, so legacy role routing degrades for every gated route. Needs its own migration-of-authority round.
- Many legacy migrations/tests/pages reference `unified_role`; none run in the Phase 13 chain.
