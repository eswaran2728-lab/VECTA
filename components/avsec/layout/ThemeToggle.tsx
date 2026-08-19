"use client";

import { useEffect, useState } from "react";

type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "avsec-theme";

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Always writes a concrete light/dark value — never leaves the attribute off for "system"
// — because Tailwind's dark: variant is bound to [data-theme="dark"]. Mirrored by the
// inline pre-paint script in layout.tsx.
function apply(pref: ThemePref) {
  document.documentElement.setAttribute("data-theme", pref === "system" ? systemTheme() : pref);
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage unavailable (private mode) — fall through to the system default.
  }
  return "system";
}

export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    setPref(readPref());
  }, []);

  // While on "system", follow live OS changes — the pre-paint script only resolves once.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => apply("system");
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [pref]);

  const choose = (next: ThemePref) => {
    setPref(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: the choice just won't persist across sessions.
    }
  };

  return { pref, choose };
}

/** Compact circle toggle shown in the app header — flips between light and dark. */
export function ThemeToggle() {
  const { pref, choose } = useThemePref();
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const resolve = () =>
      setIsDark(
        pref === "dark" ||
          (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
      );
    resolve();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", resolve);
    return () => mq.removeEventListener("change", resolve);
  }, [pref]);

  return (
    <button
      type="button"
      onClick={() => choose(isDark ? "light" : "dark")}
      title="Toggle light / dark"
      aria-label="Toggle light or dark theme"
      className="w-[34px] h-[34px] flex items-center justify-center border transition-colors"
      style={{ borderColor: "var(--line3)" }}
    >
      <span
        className="w-[13px] h-[13px] rounded-full"
        style={{
          border: "1.5px solid var(--gold)",
          background: isDark ? "transparent" : "var(--gold-fill)",
        }}
      />
    </button>
  );
}

/** Three-way LIGHT / DARK / SYSTEM selector for the profile screen. */
export function ThemeOptions() {
  const { pref, choose } = useThemePref();
  const options: ThemePref[] = ["light", "dark", "system"];

  return (
    <div className="flex gap-2">
      {options.map((opt) => {
        const on = pref === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => choose(opt)}
            className="flex-1 text-center py-3 px-1 t-mono text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors"
            style={{
              border: `1px solid ${on ? "var(--gold-fill)" : "var(--line3)"}`,
              background: on ? "var(--gold-soft)" : "transparent",
              color: on ? "var(--gold)" : "var(--mid)",
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
