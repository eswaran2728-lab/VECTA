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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

const themeInit = `
try {
  const stored = localStorage.getItem("cscs-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (stored === "dark" || (!stored && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${heading.variable} ${display.variable} ${body.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
