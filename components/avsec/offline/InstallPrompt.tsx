"use client";

import { useEffect, useState } from "react";
import { APP_NAME } from "@/lib/avsec/branding";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!deferred || dismissed) return null;

  return (
    <div className="fixed bottom-4 inset-x-4 z-20 card p-4 flex items-center justify-between gap-3 shadow-lg max-w-md mx-auto">
      <p className="text-sm font-medium">Install {APP_NAME} for quick, offline-ready access.</p>
      <div className="flex gap-2 shrink-0">
        <button className="btn-quiet" onClick={() => setDismissed(true)}>
          Later
        </button>
        <button
          className="btn-primary"
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
