"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Polls the server component every 30s so Live mode's heat map/zone cards pick up new
 * check-ins/check-outs without a manual reload — simpler than a Realtime subscription
 * and comfortably meets the "within 60 sec" requirement. */
export function LiveRefresher() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 30000);
    return () => clearInterval(interval);
  }, [router]);

  return null;
}
