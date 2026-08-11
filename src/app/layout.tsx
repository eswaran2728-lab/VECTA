import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { OfflineSyncProvider } from "@/components/offline/OfflineSyncProvider";
import { OfflineStatusBadge } from "@/components/offline/OfflineStatusBadge";
import { ServiceWorkerRegister } from "@/components/offline/ServiceWorkerRegister";
import { InstallPrompt } from "@/components/offline/InstallPrompt";
import { APP_NAME, APP_DESCRIPTION, BRAND_PAGE_LIGHT, BRAND_BLACK } from "@/lib/branding";

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
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: APP_NAME,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND_PAGE_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: BRAND_BLACK },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script below sets data-theme on <html>
    // before React hydrates, so the client markup intentionally differs from the server's.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${barlow.variable} ${barlowCondensed.variable} ${plexMono.variable}`}
    >
      <head>
        {/* Resolves the theme before first paint: no flash of the wrong palette, and the
            attribute is ALWAYS set (never left off for "system") because Tailwind's dark:
            variant keys off [data-theme="dark"]. Mirrors ThemeToggle's apply(). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var p="system";try{p=localStorage.getItem("avsec-theme")||"system"}catch(e){}var t=p==="light"||p==="dark"?p:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t)})()`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <OfflineSyncProvider>
          <ServiceWorkerRegister />
          <OfflineStatusBadge />
          {children}
          <InstallPrompt />
        </OfflineSyncProvider>
      </body>
    </html>
  );
}
