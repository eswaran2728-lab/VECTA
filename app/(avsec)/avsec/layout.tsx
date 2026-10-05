import type { Metadata } from "next";
import { OfflineSyncProvider } from "@/components/avsec/offline/OfflineSyncProvider";
import { OfflineStatusBadge } from "@/components/avsec/offline/OfflineStatusBadge";
import { ServiceWorkerRegister } from "@/components/avsec/offline/ServiceWorkerRegister";
import { InstallPrompt } from "@/components/avsec/offline/InstallPrompt";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/avsec/branding";
import { getRawProfile, getCanonicalAccess, getCanScanCaterLink } from "@/lib/avsec/auth";
import { signOut as authSignOut } from "@/lib/avsec/profile-actions";
import { ROLE_LABELS } from "@/lib/avsec/reference-data";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { NotificationsBell } from "@/components/layout/NotificationsBell";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
};

export default async function AvsecLayout({ children }: { children: React.ReactNode }) {
  // Soft check — never redirects (individual pages already gate themselves
  // via requireProfile()/requireRole()). Only used to decide whether the
  // shared header/bottom nav make sense to show yet: a signed-in user with
  // no complete, approved profile (still on /avsec/profile-setup,
  // /avsec/pending-approval, or resetting their password) has no
  // name/role/ops_group to put in them.
  const profile = await getRawProfile();
  const access = profile ? await getCanonicalAccess() : null;
  const isOrgWide = access?.orgWide ?? false;
  const showChrome = Boolean(profile && profile.status === "approved" && profile.name && access?.hasAssignment && !access.isSuperAdmin);
  const displayRole = access?.primaryCompatRole ?? "ASO";
  const canScan = showChrome && access ? await getCanScanCaterLink(access) : false;
  // Phase 7: purely a nav-display decision (see lib/dashboard/navigation.ts)
  // -- skipped entirely when chrome isn't shown anyway (profile-setup/
  // pending-approval), and an empty result just means no "My Dashboard"
  // entry, never a broken link or an authorization change.
  const hasPhase7Assignment = showChrome ? Boolean(access?.hasAssignment) : false;

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <OfflineSyncProvider ownerId={profile?.id ?? null}>
        <ServiceWorkerRegister />
        <OfflineStatusBadge />
        {showChrome && profile ? (
          <AppSidebar
            userId={profile.id}
            name={profile.name}
            role={displayRole}
            roleLabel={access?.primaryCompatRole ? (ROLE_LABELS[access.primaryCompatRole] ?? null) : (access?.roleCodes[0] ?? null)}
            canScan={canScan}
            station={profile.station}
            team={profile.team}
            hasPhase7Assignment={hasPhase7Assignment}
            signOutAction={authSignOut}
          />
        ) : null}
        <div className={showChrome ? "pb-24 lg:pb-8 lg:pl-64" : undefined}>
          {showChrome && profile ? (
            <div className="lg:hidden">
              <UnifiedHeader
                name={profile.name}
                roleLabel={access?.primaryCompatRole ? (ROLE_LABELS[access.primaryCompatRole] ?? null) : (access?.roleCodes[0] ?? null)}
                signOutAction={authSignOut}
                extra={<NotificationsBell userId={profile.id} />}
              />
            </div>
          ) : null}
          {children}
        </div>
        <InstallPrompt />
        {showChrome && profile ? (
          <TeamBottomNav orgWide={isOrgWide} role={displayRole.toLowerCase()} canScan={canScan} hasPhase7Assignment={hasPhase7Assignment} />
        ) : null}
      </OfflineSyncProvider>
    </div>
  );
}
