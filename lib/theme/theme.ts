/**
 * VECTA theme system -- pure, framework-free, local-only.
 *
 * Three user-facing choices: Light, Dark and "Use Device Setting" (follows prefers-color-scheme). The choice is kept ONLY in this
 * browser's localStorage: it is never sent to a server, never written to a profile and needs no database change. One token-based
 * design system serves both themes (CSS variables in app/globals.css), so no component is duplicated per theme.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];
export const THEME_STORAGE_KEY = "vecta-theme";
/** Keys written by earlier VECTA/AVSEC/CSCS builds; still honoured when reading so an existing choice survives the redesign. */
const LEGACY_KEYS = ["avsec-theme", "cscs-theme"] as const;

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "Use Device Setting",
};

export function parsePreference(raw: unknown): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function readStoredPreference(storage: StorageReader | null | undefined): ThemePreference {
  if (!storage) return "system";
  try {
    for (const key of [THEME_STORAGE_KEY, ...LEGACY_KEYS]) {
      const v = storage.getItem(key);
      if (v === "light" || v === "dark" || v === "system") return v;
    }
  } catch {
    // storage blocked (private mode, disabled cookies): fall back to the device setting
  }
  return "system";
}

export function storePreference(pref: ThemePreference, storage: StorageWriter | null | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // non-fatal: the choice still applies for this page view
  }
}

type RootLike = {
  setAttribute(name: string, value: string): void;
  classList: { toggle(token: string, force?: boolean): unknown };
  style: { colorScheme: string };
};

export function applyTheme(pref: ThemePreference, env: { root: RootLike; systemDark: boolean }): ResolvedTheme {
  const resolved = resolveTheme(pref, env.systemDark);
  env.root.setAttribute("data-theme", resolved);
  env.root.setAttribute("data-theme-pref", pref);
  env.root.classList.toggle("dark", resolved === "dark");
  env.root.style.colorScheme = resolved;
  return resolved;
}

/**
 * Inline script run in <head> BEFORE first paint (see app/layout.tsx), so the page never flashes the wrong theme. It must stay
 * self-contained (no imports, ES5-safe) and must never throw. It mirrors readStoredPreference / applyTheme exactly; the unit tests
 * execute it against fake environments to prove they agree.
 */
export function themeInitScript(): string {
  return `(function(){try{var d=document.documentElement,p="system";try{var ks=[${JSON.stringify(THEME_STORAGE_KEY)},"avsec-theme","cscs-theme"];for(var i=0;i<ks.length;i++){var v=localStorage.getItem(ks[i]);if(v==="light"||v==="dark"||v==="system"){p=v;break}}}catch(e){}var s=false;try{s=!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)}catch(e){}var t=p==="system"?(s?"dark":"light"):p;d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p);if(t==="dark"){d.classList.add("dark")}else{d.classList.remove("dark")}d.style.colorScheme=t}catch(e){}})();`;
}
