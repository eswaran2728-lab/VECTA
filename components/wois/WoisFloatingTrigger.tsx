"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { WoisChatModal } from "./WoisChatModal";

/** Anything the assistant button must never sit on top of: primary actions, warnings and anything a page marks with data-fab-avoid. */
const AVOID = '[data-fab-avoid], .vecta-btn-primary, .btn-primary, [role="alert"], .border-l-warning';

type Slot = "right" | "left" | "hidden";

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export function WoisFloatingTrigger({
  userContext,
}: {
  userContext?: {
    role?: string | null;
    station?: string | null;
    team?: string | null;
  };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [slot, setSlot] = useState<Slot>("right");
  const ref = useRef<HTMLButtonElement | null>(null);

  // Keeps the button clear of duty warnings and actions: it moves to the other side when it would cover one, and steps aside while both sides are covered.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      const mine = el.getBoundingClientRect();
      const w = mine.width;
      const h = mine.height;
      const rightRect = new DOMRect(window.innerWidth - 12 - w, mine.top, w, h);
      const leftRect = new DOMRect(12, mine.top, w, h);
      const targets = Array.from(document.querySelectorAll<HTMLElement>(AVOID)).filter((t) => t !== el && !el.contains(t) && !t.closest("[data-wois-modal]"));
      const rects = targets.map((t) => t.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight);
      const hitsRight = rects.some((r) => overlaps(rightRect, r));
      const hitsLeft = rects.some((r) => overlaps(leftRect, r));
      setSlot(!hitsRight ? "right" : !hitsLeft ? "left" : "hidden");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      mo.disconnect();
    };
  }, []);

  return (
    <>
      {/* Floating Action Button: compact on phones, above the bottom navigation, never over a warning or primary action */}
      <button
        ref={ref}
        onClick={() => setIsOpen(true)}
        aria-label="Open W.O.I.S AI Assistant"
        aria-hidden={slot === "hidden" ? true : undefined}
        tabIndex={slot === "hidden" ? -1 : 0}
        data-slot={slot}
        className={`fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-40 flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-primary/40 bg-primary px-3 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer sm:px-4 ${
          slot === "left" ? "left-3" : "right-3"
        } ${slot === "hidden" ? "pointer-events-none translate-y-6 opacity-0" : ""}`}
        title="Open W.O.I.S AI Assistant"
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden font-display tracking-wider sm:inline">AI</span>
      </button>

      {/* Interactive Modal */}
      <div data-wois-modal>
        <WoisChatModal isOpen={isOpen} onClose={() => setIsOpen(false)} userContext={userContext} />
      </div>
    </>
  );
}
