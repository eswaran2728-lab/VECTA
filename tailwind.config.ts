import type { Config } from "tailwindcss";

const config: Config = {
  // "media": there's no manual light/dark toggle anywhere in the app, so dark mode
  // should just follow the device's system setting — matches what globals.css assumed.
  darkMode: "media",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // AirAsia red — matches the AirAsia / AVSEC AirAsia badge logos.
        brand: {
          50: "#fff1f0",
          100: "#ffdcda",
          200: "#ffbab6",
          300: "#ff8d86",
          400: "#ff5951",
          500: "#fb2920",
          600: "#e2001a",
          700: "#b80016",
          800: "#8f0014",
          900: "#6e0512",
        },
        // AVSEC badge gold — used sparingly for accents/highlights alongside brand red.
        gold: {
          50: "#fffceb",
          100: "#fff6c2",
          200: "#ffec85",
          300: "#ffdc40",
          400: "#ffc915",
          500: "#f5b400",
          600: "#d18f00",
          700: "#a86b02",
          800: "#8a5408",
          900: "#74450b",
        },
        amber: {
          50: "#fffbeb",
          100: "#fef3c7",
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
        },
      },
      fontSize: {
        base: ["1rem", "1.5rem"],
      },
    },
  },
  plugins: [],
};

export default config;
