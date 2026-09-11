import type { Metadata } from "next";
import { OfflineSyncProvider } from "@/components/avsec/offline/OfflineSyncProvider";
import { OfflineStatusBadge } from "@/components/avsec/offline/OfflineStatusBadge";
import { ServiceWorkerRegister } from "@/components/avsec/offline/ServiceWorkerRegister";
import { InstallPrompt } from "@/components/avsec/offline/InstallPrompt";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/avsec/branding";
import { getCurrentProfile } from "@/lib/avsec/auth";
import { signOut as authSignOut } from "@/lib/avsec/profile-actions";
import { ORG_WIDE_ROLES, ROLE_LABELS } from "@/lib/avsec/reference-data";
import { ThemeToggle } from "@/components/avsec/layout/ThemeToggle";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";

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
  const profile = await getCurrentProfile();
  const isOrgWide = profile ? (ORG_WIDE_ROLES as readonly string[]).includes(profile.role) : false;
  const showChrome = Boolean(
    profile &&
      profile.status === "approved" &&
      profile.name &&
      (isOrgWide || (profile.station && profile.team))
  );

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <OfflineSyncProvider>
        <ServiceWorkerRegister />
        <OfflineStatusBadge />
        <div className={showChrome ? "pb-24" : undefined}>
          {showChrome && profile ? (
            <UnifiedHeader
              name={profile.name}
              roleLabel={ROLE_LABELS[profile.role] ?? null}
              signOutAction={authSignOut}
              extra={<ThemeToggle />}
            />
          ) : null}
          {children}
        </div>
        <InstallPrompt />
        {showChrome && profile ? (
          <TeamBottomNav opsGroup={profile.ops_group} orgWide={isOrgWide} />
        ) : null}
      </OfflineSyncProvider>
    </div>
  );
}
