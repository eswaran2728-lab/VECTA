// Single source of truth for app name/branding, referenced from metadata, the login
// screen, manifest.json generation points, and anywhere else the name is shown.
export const APP_NAME = "AVSEC REPORTS";
export const APP_DESCRIPTION = "AirAsia AVSEC digital security reporting platform";

// Matches the `brand`/`gold` scales in tailwind.config.ts — kept here too for the few
// places that need a raw hex value outside Tailwind classes (manifest.json theme_color,
// <meta name="theme-color">, @react-pdf/renderer styles, which can't reference Tailwind).
export const BRAND_RED = "#e2001a";
export const BRAND_RED_DARK = "#8f0014";
export const BRAND_GOLD = "#f5b400";
export const BRAND_BLACK = "#0a0a0a";
