import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.avsec.css";
import { OfflineSyncProvider } from "@/components/avsec/offline/OfflineSyncProvider";
import { OfflineStatusBadge } from "@/components/avsec/offline/OfflineStatusBadge";
import { ServiceWorkerRegister } from "@/components/avsec/offline/ServiceWorkerRegister";
import { InstallPrompt } from "@/components/avsec/offline/InstallPrompt";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/avsec/branding";

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

export default function AvsecLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`avsec-scope ${barlow.variable} ${barlowCondensed.variable} ${plexMono.variable} min-h-screen antialiased`}
    >
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var el=document.currentScript.parentElement;var p="system";try{p=localStorage.getItem("avsec-theme")||"system"}catch(e){}var t=p==="light"||p==="dark"?p:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");el.setAttribute("data-theme",t)})()`,
        }}
      />
      <OfflineSyncProvider>
        <ServiceWorkerRegister />
        <OfflineStatusBadge />
        {children}
        <InstallPrompt />
      </OfflineSyncProvider>
    </div>
  );
}
