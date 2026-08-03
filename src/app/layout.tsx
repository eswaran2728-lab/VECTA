import type { Metadata, Viewport } from "next";
import "./globals.css";
import { OfflineSyncProvider } from "@/components/offline/OfflineSyncProvider";
import { OfflineStatusBadge } from "@/components/offline/OfflineStatusBadge";
import { ServiceWorkerRegister } from "@/components/offline/ServiceWorkerRegister";
import { InstallPrompt } from "@/components/offline/InstallPrompt";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/branding";

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  manifest: "/manifest.json",
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/icon.svg",
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
    { media: "(prefers-color-scheme: light)", color: "#1d5cf5" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
