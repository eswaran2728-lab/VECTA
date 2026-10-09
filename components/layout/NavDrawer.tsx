"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import type { NavGroupModel } from "@/lib/dashboard/nav-capabilities";
import { NavGroupsList } from "@/components/layout/NavGroupsList";

/**
 * Tablet / mobile navigation drawer (below the lg breakpoint, where the fixed desktop sidebar is not drawn). It renders the SAME
 * model as the sidebar, so the two can never disagree. Keyboard accessible: Esc closes, focus moves into the panel on open and back
 * to the trigger on close, Tab stays inside while open, and a route change closes it.
 */
export function NavDrawer({ groups, label = "Menu" }: { groups: NavGroupModel[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>("a[href],button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Open ${label.toLowerCase()}`}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border text-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
          <button type="button" aria-label="Close menu" tabIndex={-1} onClick={close} className="absolute inset-0 h-full w-full cursor-default bg-black/50" />
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="font-display text-base font-extrabold tracking-wider">VECTA</span>
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <nav aria-label="Primary" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
              <NavGroupsList groups={groups} onNavigate={() => setOpen(false)} />
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}
