"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportType } from "@/lib/avsec/reference-data";
import { saveDraft } from "@/lib/avsec/reports/drafts";

const AUTOSAVE_DELAY_MS = 1200;

function localKey(type: ReportType) {
  return `avsec-ops:draft:${type}`;
}

export function readLocalDraft<T>(type: ReportType): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(localKey(type));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function clearLocalDraft(type: ReportType) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(localKey(type));
}

/**
 * Debounced draft autosave: writes to localStorage immediately (survives offline/reload),
 * and best-effort mirrors to the server draft table when online.
 */
export function useDraftAutosave<T>(type: ReportType, values: T, enabled = true) {
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(localKey(type), JSON.stringify(values));
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setSavedAt(new Date());
        return;
      }
      saveDraft(type, values)
        .then(() => setSavedAt(new Date()))
        .catch(() => {
          /* local copy already persisted; server mirror is best-effort */
        });
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(values), enabled, type]);

  return { savedAt };
}
