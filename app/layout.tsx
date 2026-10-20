import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Sora } from "next/font/google";
import { themeInitScript } from "@/lib/theme/theme";
import "./globals.css";

// Sora is the single VECTA typeface (Stitch direction): body, headings and display all resolve to it through the
// --font-body variable (tailwind font-sans / font-heading / font-display). The earlier display and heading faces were retired.
const body = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-body",
  display: "swap",
});
// JetBrains Mono replaces IBM Plex Mono for all data readouts (IDs,
// timestamps, counts), matching the mockups.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "VECTA",
    template: "%s | VECTA",
  },
  description:
    "VECTA — unified AirAsia operations platform: IFC catering security workflow and AVSEC duty & reporting.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "VECTA", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

// Theme (Light / Dark / Use Device Setting) is applied by lib/theme/theme.ts before first paint; see themeInitScript().
const themeInit = themeInitScript();

import { WoisFloatingTrigger } from "@/components/wois/WoisFloatingTrigger";
import { getCurrentProfile, getPortalIdentity } from "@/lib/avsec/auth";
import { isCaterLinkOnly } from "@/lib/auth/caterlink-access";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Server-derived, minimized role context for the WOIS floating trigger --
  // never client-supplied. `getCurrentProfile()` returns null for signed-out
  // visitors (login/register pages), which is the correct "no context"
  // case; this is cosmetic context only (used for UI copy and role-adapted
  // suggestions), never an authorization input -- every WOIS API route
  // re-derives the caller's identity and eligibility from the authenticated
  // session itself, ignoring whatever this value says.
  const profile = await getCurrentProfile();
  // CaterLink-only (and conflicting / blocked) identities have no VECTA assistant: the widget is not offered, and the
  // WOIS APIs answer 403 for them server-side regardless.
  const portal = await getPortalIdentity();
  const showWois = !(isCaterLinkOnly(portal.kind) || portal.kind === "conflict" || portal.kind === "blocked");
  const woisUserContext = profile
    ? {
        role: profile.role,
        station: profile.station ?? null,
        team: profile.team ?? null,
      }
    : undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${body.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {children}
        {showWois && <WoisFloatingTrigger userContext={woisUserContext} />}
      </body>
    </html>
  );
}
