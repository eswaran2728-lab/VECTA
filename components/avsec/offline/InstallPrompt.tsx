"use client";

import { useEffect, useState } from "react";
import { APP_NAME } from "@/lib/avsec/branding";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // If dismissed previously, do not show
    if (typeof window !== "undefined" && localStorage.getItem("vecta_pwa_dismissed")) {
      return;
    }
    setDismissed(false);

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!deferred || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      localStorage.setItem("vecta_pwa_dismissed", "true");
    }
  };

  return (
    <div className="fixed bottom-4 inset-x-4 z-50 card p-4 flex items-center justify-between gap-3 shadow-lg max-w-md mx-auto border border-border/80 bg-surface/95 backdrop-blur">
      <p className="text-sm font-medium">Install {APP_NAME} to your device for quick access.</p>
      <div className="flex gap-2 shrink-0">
        <button className="btn-quiet text-xs" onClick={handleDismiss}>
          Later
        </button>
        <button
          className="btn-primary text-xs"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
        >
          Install
        </button>
      </div>
    </div>
  );
}
