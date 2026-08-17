"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Profile } from "@/lib/types";
import type { UserRole } from "@/lib/reference-data";

interface NavItem {
  href: string;
  label: string;
  /** Marker shape, mirroring the prototype's geometric nav glyphs. */
  round: string;
  rot: string;
  /** Extra path prefixes that should also light this tab up. */
  match?: string[];
}

// ASO submits reports, so their primary surface is Home + the report FAB. Monitoring
// roles land on the dashboard instead.
function navFor(role: UserRole): { left: NavItem[]; right: NavItem[]; fab: { href: string; label: string } } {
  const canSubmitDaily = role === "SO" || role === "DSE";

  if (role === "ASO") {
    return {
      left: [
        { href: "/home", label: "HOME", round: "2px", rot: "0deg" },
        { href: "/duty", label: "DUTY", round: "50%", rot: "45deg" },
      ],
      right: [
        { href: "/bay-board", label: "BAY BOARD", round: "2px", rot: "45deg" },
        { href: "/profile", label: "PROFILE", round: "7px", rot: "0deg" },
      ],
      fab: { href: "/home", label: "REPORT" },
    };
  }

  return {
    left: [
      { href: "/dashboard", label: "DASHBOARD", round: "2px", rot: "0deg" },
      { href: "/duty", label: "DUTY", round: "50%", rot: "45deg" },
    ],
    right: [
      { href: "/bay-board", label: "BAY BOARD", round: "2px", rot: "45deg" },
      { href: "/profile", label: "PROFILE", round: "7px", rot: "0deg" },
    ],
    fab: canSubmitDaily ? { href: "/reports/sec014", label: "REPORT" } : { href: "/dashboard", label: "REVIEW" },
  };
}

export function BottomNav({ profile }: { profile: Profile }) {
  const pathname = usePathname();
  const { left, right, fab } = navFor(profile.role);

  const isActive = (item: NavItem) =>
    pathname === item.href || (item.match ?? []).some((m) => pathname.startsWith(m));

  const Tab = ({ item }: { item: NavItem }) => {
    const active = isActive(item);
    const color = active ? "var(--gold)" : "var(--faint)";
    return (
      <Link
        href={item.href}
        className="flex flex-col items-center gap-1.5 pt-1.5 cursor-pointer"
        aria-current={active ? "page" : undefined}
      >
        <span
          className="w-3.5 h-3.5"
          style={{
            background: active ? "var(--gold)" : "transparent",
            border: `1.5px solid ${color}`,
            borderRadius: item.round,
            transform: `rotate(${item.rot})`,
          }}
        />
        <span
          className="t-mono text-[8px] font-semibold whitespace-nowrap"
          style={{ letterSpacing: "0.06em", color }}
        >
          {item.label}
        </span>
      </Link>
    );
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30"
      style={{ background: "var(--surface)", borderTop: "1px solid var(--line)" }}
    >
      <div className="relative max-w-3xl mx-auto grid grid-cols-5 items-end px-1.5 pt-2.5 pb-[22px]">
        {left.map((item) => (
          <Tab key={item.href} item={item} />
        ))}
        <span aria-hidden />
        {right.map((item) => (
          <Tab key={item.href} item={item} />
        ))}

        <Link
          href={fab.href}
          className="absolute left-1/2 -translate-x-1/2 bottom-11 w-[60px] h-[60px] rounded-full flex flex-col items-center justify-center transition-colors"
          style={{
            background: "var(--gold-fill)",
            border: "5px solid var(--surface)",
            boxShadow: "0 8px 24px var(--gold-glow)",
          }}
        >
          <span className="text-[19px] leading-none -mt-0.5" style={{ color: "var(--on-gold)" }}>
            +
          </span>
          <span
            className="t-mono text-[7px] font-bold"
            style={{ letterSpacing: "0.06em", color: "var(--on-gold)" }}
          >
            {fab.label}
          </span>
        </Link>
      </div>
    </nav>
  );
}
