import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Orbitron, Plus_Jakarta_Sans, Sora } from "next/font/google";
import "./globals.css";

// Plus Jakarta Sans stays as the general `font-heading` family — it's used
// across the ~20 screens outside this redesign's scope (reports, admin,
// incidents, duty, etc.) and isn't part of the three approved mockups.
const heading = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-heading",
  display: "swap",
});
// Orbitron — the "ops console" display/heading face (VECTA wordmark,
// section titles) from the approved FutLogin/FutDashboard/FutScan mockups.
const display = Orbitron({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
// Sora replaces Inter as the base body font, matching the mockups.
const body = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

// Light by default — only an explicit stored choice (via the theme toggle)
// switches to dark mode; defaults cleanly to light theme.
const themeInit = `
try {
  const stored = localStorage.getItem("vecta-theme") || localStorage.getItem("avsec-theme") || localStorage.getItem("cscs-theme");
  if (stored === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.classList.remove("dark");
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (e) {}
`;

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
      className={`${heading.variable} ${display.variable} ${body.variable} ${mono.variable}`}
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
