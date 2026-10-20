"use client";

import { useEffect, useId, useRef } from "react";

/**
 * Accessible confirmation dialog: role=dialog + aria-modal, labelled and described, focus moves in on open and returns to the
 * opener on close, Tab/Shift+Tab are trapped, Escape cancels, and the destructive intent is stated in words (not colour).
 */
export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="presentation">
      <div className="absolute inset-0 bg-black/60" aria-hidden onClick={onCancel} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 text-card-foreground shadow-xl">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <p id={descId} className="mt-1 text-sm text-muted-foreground">{description}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" data-autofocus onClick={onCancel} className="min-h-[44px] rounded-lg border border-border px-4 text-sm font-semibold text-foreground">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold ${destructive ? "bg-destructive text-destructive-foreground" : "bg-brand text-brand-foreground"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
