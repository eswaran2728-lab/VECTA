"use client";

import { useEffect, useRef, useState } from "react";
import { saveDraft } from "@/lib/avsec/reports/drafts";

const AUTOSAVE_DELAY_MS = 1200;

function legacyKey(type: string) {
  return `avsec-ops:draft:${type}`;
}

function scopedKey(userId: string, type: string) {
  return `avsec-ops:draft:${userId}:${type}`;
}

/**
 * Reads this user's local draft. Also migrates a legacy unscoped draft
 * (written before draft keys included the user id — see below) into the
 * scoped key on first read, then removes the legacy key so it can never
 * be picked up by a different user afterward. Migration only fires when
 * this user has no scoped draft of their own yet, so it never overwrites
 * a draft they've already started under the new scheme.
 */
export function readLocalDraft<T>(userId: string, type: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const scoped = window.localStorage.getItem(scopedKey(userId, type));
    if (scoped) return JSON.parse(scoped) as T;

    const legacy = window.localStorage.getItem(legacyKey(type));
    if (legacy) {
      window.localStorage.setItem(scopedKey(userId, type), legacy);
      window.localStorage.removeItem(legacyKey(type));
      return JSON.parse(legacy) as T;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearLocalDraft(userId: string, type: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(scopedKey(userId, type));
}

/**
 * Debounced draft autosave: writes to localStorage immediately (survives offline/reload),
 * and best-effort mirrors to the server draft table when online. Keys are scoped to
 * `userId` — a shared device must never let one signed-in user see another's local draft.
 */
export function useDraftAutosave<T>(userId: string, type: string, values: T, enabled = true) {
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(scopedKey(userId, type), JSON.stringify(values));
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
  }, [JSON.stringify(values), enabled, type, userId]);

  return { savedAt };
}
