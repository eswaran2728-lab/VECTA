"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface BigCheckboxProps {
  id: string;
  name?: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  required?: boolean;
}

/**
 * Large tap-friendly checkbox for AVSEC checkpoint checklists.
 * The whole row is the touch target (tablet/phone friendly).
 */
export function BigCheckbox({
  id,
  name,
  label,
  description,
  checked,
  onCheckedChange,
  required,
}: BigCheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors",
        checked
          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40"
          : "border-input bg-background hover:bg-accent"
      )}
    >
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        required={required}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="h-6 w-6 shrink-0 accent-emerald-600"
      />
      <span className="flex flex-col">
        <span className="text-base font-medium">{label}</span>
        {description ? (
          <span className="text-sm text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
