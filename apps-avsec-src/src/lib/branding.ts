// Single source of truth for app name/branding, referenced from metadata, the login
// screen, manifest.json generation points, and anywhere else the name is shown.
export const APP_NAME = "AVSEC REPORTS";
export const APP_DESCRIPTION = "AirAsia AVSEC digital security reporting platform";

// Raw hex values for the few places that can't reference Tailwind/CSS variables —
// manifest.json theme_color, <meta name="theme-color">, @react-pdf/renderer styles.
// Mirrors the token set in globals.css.
export const BRAND_GOLD = "#FFD900";
export const BRAND_RED = "#E30613";
export const BRAND_BLACK = "#050505";
export const BRAND_PAGE_LIGHT = "#EFEDE6";

// Kept for the PDF templates, which were built against the previous red/gold pair.
export const BRAND_RED_DARK = "#8f0014";
