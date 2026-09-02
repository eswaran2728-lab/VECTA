import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.avsec.css";
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

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
});

const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-avsec",
  display: "swap",
});

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
    <div
      className={`avsec-scope ${barlow.variable} ${barlowCondensed.variable} ${plexMono.variable} min-h-screen antialiased`}
    >
      {/* Light by default — only an explicit stored "dark" choice ever
          switches this; OS prefers-color-scheme is not consulted, so a
          device set to dark mode does not silently darken this section. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var el=document.currentScript.parentElement;var p="light";try{p=localStorage.getItem("avsec-theme")||"light"}catch(e){}var t=p==="dark"?"dark":"light";el.setAttribute("data-theme",t)})()`,
        }}
      />
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
