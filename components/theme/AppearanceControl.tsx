"use client";

import { useId } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from "@/lib/theme/theme";
import { useThemePreference } from "@/components/theme/ThemeProvider";
import { cn } from "@/lib/avsec/utils";

const ICONS: Record<ThemePreference, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * Appearance selector (More -> Appearance, Profile -> Appearance). A real radio group: arrow keys move between options, the checked
 * option is announced, and the choice is never carried by colour alone (icon + label + checked state).
 */
export function AppearanceControl({ className }: { className?: string }) {
  const { pref, choose } = useThemePreference();
  const name = useId();
  return (
    <fieldset className={cn("min-w-0", className)}>
      <legend className="mb-2 text-sm font-semibold text-foreground">Appearance</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Appearance">
        {THEME_PREFERENCES.map((opt) => {
          const Icon = ICONS[opt];
          const checked = pref === opt;
          return (
            <label
              key={opt}
              className={cn(
                "relative flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
                checked ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <input type="radio" name={name} value={opt} checked={checked} onChange={() => choose(opt)} className="sr-only" />
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1">{THEME_LABELS[opt]}</span>
              {checked ? <span className="text-xs font-semibold text-primary" aria-hidden>✓ On</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Compact one-tap Light/Dark toggle for the desktop header only (never in the mobile bottom navigation). */
export function ThemeQuickToggle({ className, tone = "surface" }: { className?: string; tone?: "surface" | "shell" }) {
  const { pref, choose } = useThemePreference();
  // Cycles Light -> Dark -> Use Device Setting so the quick control can reach all three states.
  const order: ThemePreference[] = ["light", "dark", "system"];
  const next = order[(order.indexOf(pref) + 1) % order.length];
  const Icon = ICONS[pref];
  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={`Appearance: ${THEME_LABELS[pref]}. Switch to ${THEME_LABELS[next]}`}
      title={`Appearance: ${THEME_LABELS[pref]}`}
      className={cn(
        "inline-flex h-11 w-11 items-center justify-center rounded-xl transition-colors",
        tone === "shell" ? "text-shell-muted hover:bg-white/5 hover:text-shell-foreground" : "border border-border bg-card text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
