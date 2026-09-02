"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface BottomNavItem {
  href: string;
  label: string;
  // Pre-rendered by the server component (AppLayout), not a component
  // reference — a lucide-react icon component itself can't be passed as a
  // prop across the server/client boundary ("Functions cannot be passed
  // directly to Client Components"); a rendered element can.
  icon: ReactNode;
}

/**
 * ICMS's original per-role mobile bottom nav (unchanged), except it now
 * hides itself on /icms/transactions — that page renders the new shared
 * TeamBottomNav instead (see app/(icms)/icms/transactions/page.tsx), so the
 * two bottom bars never stack on top of each other. Every other ICMS page
 * keeps this nav exactly as before.
 */
export function IcmsMobileBottomNav({ items }: { items: BottomNavItem[] }) {
  const pathname = usePathname();
  if (pathname === "/icms/transactions") return null;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-card md:hidden print:hidden">
      <div className="grid auto-cols-fr grid-flow-col">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={
              item.href === "/scan" || item.href === "/transactions/new"
                ? "flex flex-col items-center gap-1 py-2.5 text-[11px] font-bold text-primary"
                : "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {item.icon}
            {item.label.split(" ")[0]}
          </Link>
        ))}
      </div>
    </nav>
  );
}
