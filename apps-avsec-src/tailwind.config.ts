import type { Config } from "tailwindcss";

const config: Config = {
  // Theme is driven by CSS variables in globals.css (system preference + an explicit
  // [data-theme] override on <html>), so Tailwind's own dark: variant follows the same
  // attribute rather than duplicating the palette in two places.
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./src/app/**/*.{ts,tsx}", "./src/components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "var(--surface)",
        panel: "var(--panel)",
        panel2: "var(--panel2)",
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink2)",
          3: "var(--ink3)",
        },
        mid: "var(--mid)",
        soft: "var(--soft)",
        faint: "var(--faint)",
        faintest: "var(--faintest)",
        line: {
          DEFAULT: "var(--line)",
          2: "var(--line2)",
          3: "var(--line3)",
        },
        gold: {
          DEFAULT: "var(--gold)",
          fill: "var(--gold-fill)",
          hi: "var(--gold-fill-hi)",
          soft: "var(--gold-soft)",
        },
        // AirAsia red — reserved for security-sensitive forms and destructive actions.
        red: {
          DEFAULT: "var(--red)",
          soft: "var(--red-soft)",
          ink: "var(--red-ink)",
        },
        // `brand` was the old red accent scale. The primary accent is now gold, so the
        // numeric steps are aliased onto the new tokens by role (tint / border / accent /
        // surface) — this keeps screens not yet reworked on-palette instead of unstyled.
        brand: {
          DEFAULT: "var(--gold)",
          50: "var(--gold-soft)",
          100: "var(--gold-soft)",
          200: "var(--line3)",
          300: "var(--line3)",
          400: "var(--gold)",
          500: "var(--gold)",
          600: "var(--gold)",
          700: "var(--gold)",
          800: "var(--gold)",
          900: "var(--panel)",
          950: "var(--panel2)",
        },
        ok: "var(--green)",
        info: "var(--blue)",
        "on-gold": "var(--on-gold)",
      },
      fontFamily: {
        sans: ["var(--font-barlow)", "system-ui", "sans-serif"],
        condensed: ["var(--font-barlow-condensed)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        // The design language is square-cornered throughout.
        none: "0",
      },
      animation: {
        slide: "avslide .25s ease both",
        pulse: "avpulse 2s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
