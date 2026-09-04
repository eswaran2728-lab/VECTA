#!/usr/bin/env bash
# Fails the build if a Supabase (or Firebase, once Phase 3 lands) auth SDK
# session/identity call is made from outside lib/auth/providers/. Those
# calls should go through lib/auth/provider.ts's getAuthProvider() (or
# lib/auth/guards.ts's getAuthUser()/requireAuth()) instead — see
# MIGRATION-AUDIT.md and the master migration plan's Phase 1.
#
# Deliberately out of scope: auth.admin.createUser/deleteUser (account
# provisioning isn't part of the AuthProvider interface in
# lib/auth/types.ts — Firebase Admin SDK's shape differs enough that this
# gets its own adapter in Phase 3) and plain .from(...)/.storage.*
# Supabase calls, which have nothing to do with authentication.
set -euo pipefail

cd "$(dirname "$0")/.."

METHODS='\.auth\.(getUser|getSession|signInWithPassword|signOut|onAuthStateChange|refreshSession|exchangeCodeForSession)\('

# Files allowed to call these directly because they ARE the adapter, or
# because they're a pre-existing Supabase-specific flow with no
# AuthProvider equivalent yet (see inline comment at each site).
ALLOWLIST=(
  "./lib/auth/providers/supabase.ts"
  "./lib/auth/providers/firebase.ts"
  "./app/(avsec)/avsec/auth/callback/route.ts"
)

is_allowed() {
  local f="$1"
  for allowed in "${ALLOWLIST[@]}"; do
    [ "$f" = "$allowed" ] && return 0
  done
  return 1
}

violations=()
while IFS= read -r -d '' file; do
  is_allowed "$file" && continue
  if grep -qE "$METHODS" "$file"; then
    violations+=("$file")
  fi
done < <(find . -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path './node_modules/*' -not -path './.next/*' -print0)

if [ "${#violations[@]}" -gt 0 ]; then
  echo "auth boundary violation: supabase.auth session/identity calls found outside lib/auth/providers/:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "Route these through lib/auth/provider.ts's getAuthProvider() or lib/auth/guards.ts instead." >&2
  exit 1
fi

echo "auth boundary check passed."
