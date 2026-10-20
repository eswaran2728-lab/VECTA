"use client";

/**
 * Compatibility shim: the theme system now lives in lib/theme/theme.ts (pure logic), components/theme/ThemeProvider.tsx (store) and
 * components/theme/AppearanceControl.tsx (controls). These names stay exported so existing callers (headers, profile, login) keep
 * working and all of them share ONE preference store -- there is no second implementation to drift.
 */
export { ThemeQuickToggle as ThemeToggle, AppearanceControl as ThemeOptions } from "@/components/theme/AppearanceControl";
export { useThemePreference as useThemePref } from "@/components/theme/ThemeProvider";
