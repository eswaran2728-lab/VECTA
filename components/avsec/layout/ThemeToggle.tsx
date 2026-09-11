"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/avsec/utils";

type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "avsec-theme";

// Always resolves to light — the app no longer follows OS
// prefers-color-scheme (a device set to dark mode should not silently
// darken it); "system" as a stored preference is treated the same as
// "light" until a user makes an explicit choice.
function systemTheme(): "light" | "dark" {
  return "dark";
}

// Always writes a concrete light/dark value
function apply(pref: ThemePref) {
  const resolved = pref === "system" ? systemTheme() : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage unavailable (private mode)
  }
  return "dark";
}

export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>("dark");

  useEffect(() => {
    setPref(readPref());
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    apply("dark");
  }, [pref]);

  const choose = (next: ThemePref) => {
    setPref(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal
    }
  };

  return { pref, choose };
}

/** Compact toggle shown in the app header */
export function ThemeToggle() {
  const { pref, choose } = useThemePref();
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    setIsDark(pref !== "light");
  }, [pref]);

  return (
    <button
      type="button"
      onClick={() => choose(isDark ? "light" : "dark")}
      title="Toggle theme"
      aria-label="Toggle theme"
      className="w-8 h-8 rounded-lg flex items-center justify-center border border-border/80 bg-surface hover:border-primary/50 text-muted-foreground hover:text-foreground transition-all cursor-pointer"
    >
      <span
        className={cn(
          "w-3.5 h-3.5 rounded-full border border-primary transition-all",
          isDark ? "bg-primary shadow-[0_0_6px_rgba(59,130,246,0.5)]" : "bg-transparent"
        )}
      />
    </button>
  );
}

/** Three-way LIGHT / DARK / SYSTEM selector for the profile screen. */
export function ThemeOptions() {
  const { pref, choose } = useThemePref();
  const options: ThemePref[] = ["dark", "light", "system"];

  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((opt) => {
        const on = pref === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => choose(opt)}
            className={cn(
              "py-2.5 px-2 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer",
              on
                ? "bg-primary text-primary-foreground font-bold shadow-sm"
                : "border border-border/80 bg-surface/60 text-muted-foreground hover:bg-surface hover:text-foreground"
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
