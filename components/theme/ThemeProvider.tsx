"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, applyTheme, readStoredPreference, storePreference, type ThemePreference } from "@/lib/theme/theme";

/**
 * Client-side theme store. The pre-hydration script in app/layout.tsx has already applied the theme, so this only (a) exposes the
 * preference to controls, (b) applies changes WITHOUT a reload (forms and navigation state are untouched -- only attributes on
 * <html> change), (c) re-applies when the device setting changes while "Use Device Setting" is selected, and (d) keeps other tabs in
 * sync through the storage event. Server snapshot is "system" so server and first client render agree (no hydration mismatch).
 */
const listeners = new Set<() => void>();
let current: ThemePreference | null = null;

function systemDark(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function snapshot(): ThemePreference {
  if (current === null) current = readStoredPreference(typeof window === "undefined" ? null : window.localStorage);
  return current;
}

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setThemePreference(next: ThemePreference): void {
  current = next;
  storePreference(next, typeof window === "undefined" ? null : window.localStorage);
  applyTheme(next, { root: document.documentElement, systemDark: systemDark() });
  emit();
}

export function useThemePreference() {
  const pref = useSyncExternalStore(subscribe, snapshot, () => "system" as ThemePreference);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onDeviceChange = () => {
      if (snapshot() === "system") applyTheme("system", { root: document.documentElement, systemDark: systemDark() });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      current = readStoredPreference(window.localStorage);
      applyTheme(current, { root: document.documentElement, systemDark: systemDark() });
      emit();
    };
    media?.addEventListener?.("change", onDeviceChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media?.removeEventListener?.("change", onDeviceChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const choose = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { pref, choose };
}
