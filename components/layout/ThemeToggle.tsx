"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/avsec/utils";

type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "vecta-theme";

function systemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function apply(pref: ThemePref) {
  const resolved = pref === "system" ? systemTheme() : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("avsec-theme") || localStorage.getItem("cscs-theme");
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage unavailable
  }
  // Default to light when no preference exists
  return "light";
}

export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>("light");

  useEffect(() => {
    const initial = readPref();
    setPref(initial);
    apply(initial);
  }, []);

  const choose = (next: ThemePref) => {
    setPref(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.setItem("avsec-theme", next);
      localStorage.setItem("cscs-theme", next);
    } catch {
      // Non-fatal
    }
  };

  return { pref, choose };
}

/**
 * Universal ThemeToggle shown in the header / navigation across all VECTA surfaces.
 * Defaults to light theme with an intuitive one-click toggle to dark mode.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { pref, choose } = useThemePref();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(pref === "dark");
  }, [pref]);

  const toggle = () => {
    choose(isDark ? "light" : "dark");
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn(
        "group relative flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition-all duration-200 hover:border-primary hover:text-foreground hover:shadow-sm active:scale-95 cursor-pointer",
        className
      )}
    >
      {isDark ? (
        <Sun className="h-4 w-4 text-amber-400 transition-transform duration-300 group-hover:rotate-45" />
      ) : (
        <Moon className="h-4 w-4 text-primary transition-transform duration-300 group-hover:-rotate-12" />
      )}
    </button>
  );
}

/** Three-way LIGHT / DARK / SYSTEM selector for settings & profile views. */
export function ThemeOptions() {
  const { pref, choose } = useThemePref();
  const options: ThemePref[] = ["light", "dark", "system"];

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
              "cursor-pointer rounded-lg py-2.5 px-2 font-mono text-xs font-semibold uppercase tracking-wider transition-all",
              on
                ? "bg-primary text-primary-foreground font-bold shadow-sm"
                : "border border-border/80 bg-card/60 text-muted-foreground hover:bg-card hover:text-foreground"
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
