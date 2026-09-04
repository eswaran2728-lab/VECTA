#!/usr/bin/env bash
# Fails the build if a Supabase or Firebase auth SDK session/identity call
# is made from outside lib/auth/providers/, or if the Firebase SDK
# (firebase/*, firebase-admin/*) is imported from outside that folder at
# all. Those calls should go through lib/auth/provider.ts's
# getAuthProvider() (or lib/auth/guards.ts's getAuthUser()/requireAuth())
# instead — see MIGRATION-AUDIT.md and the master migration plan's Phases
# 1 and 3.
#
# Deliberately out of scope: auth.admin.createUser/deleteUser (account
# provisioning isn't part of the AuthProvider interface in
# lib/auth/types.ts) and plain .from(...)/.storage.* Supabase calls
# (lib/supabase/{client,server,admin}.ts's raw @supabase/ssr and
# @supabase/supabase-js client construction is DB access, not identity —
# not checked here at all, on purpose).
set -euo pipefail

cd "$(dirname "$0")/.."

METHODS='\.auth\.(getUser|getSession|signInWithPassword|signOut|onAuthStateChange|refreshSession|exchangeCodeForSession)\('
FIREBASE_IMPORT='from ["'"'"'](firebase|firebase-admin)(/|["'"'"'])'

# Files allowed to call these directly because they ARE the adapter, or
# because they're a pre-existing Supabase-specific flow with no
# AuthProvider equivalent yet (see inline comment at each site).
ALLOWLIST=(
  "./lib/auth/providers/supabase.ts"
  "./lib/auth/providers/firebase.ts"
  "./lib/auth/providers/firebase-admin.ts"
  "./lib/auth/providers/firebase-client.ts"
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
firebase_violations=()
while IFS= read -r -d '' file; do
  is_allowed "$file" && continue
  if grep -qE "$METHODS" "$file"; then
    violations+=("$file")
  fi
  if grep -qE "$FIREBASE_IMPORT" "$file"; then
    firebase_violations+=("$file")
  fi
done < <(find . -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path './node_modules/*' -not -path './.next/*' -print0)

if [ "${#violations[@]}" -gt 0 ]; then
  echo "auth boundary violation: supabase.auth session/identity calls found outside lib/auth/providers/:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "Route these through lib/auth/provider.ts's getAuthProvider() or lib/auth/guards.ts instead." >&2
  exit 1
fi

if [ "${#firebase_violations[@]}" -gt 0 ]; then
  echo "auth boundary violation: firebase/firebase-admin imported outside lib/auth/providers/:" >&2
  printf '  %s\n' "${firebase_violations[@]}" >&2
  echo "Wrap the SDK call in a lib/auth/providers/firebase*.ts export instead." >&2
  exit 1
fi

echo "auth boundary check passed."
