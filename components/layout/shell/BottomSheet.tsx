"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

/**
 * Mobile bottom sheet used by the Actions / Alerts / More tabs. A real modal dialog: labelled, focus moves in on open and returns to
 * the tab that opened it, Tab is trapped, Escape closes, the page behind does not scroll, and the backdrop closes it on tap.
 */
export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("[data-sheet-close]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled])"));
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
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="presentation">
      <button type="button" aria-label={`Close ${title}`} tabIndex={-1} onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border border-b-0 border-border bg-card text-card-foreground shadow-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button type="button" data-sheet-close onClick={onClose} aria-label={`Close ${title}`} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">{children}</div>
      </div>
    </div>
  );
}
