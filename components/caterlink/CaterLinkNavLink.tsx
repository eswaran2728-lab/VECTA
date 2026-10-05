"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Active-aware link used by the CaterLink shell (desktop sidebar and mobile bottom bar). */
export function CaterLinkNavLink({
  href,
  label,
  icon,
  variant,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  variant: "sidebar" | "bottom";
}) {
  const pathname = usePathname() ?? "";
  // The middleware maps /icms/* to /caterlink/*; treat both prefixes as the same place.
  const norm = (p: string) => p.replace(/^\/caterlink/, "/icms");
  const here = norm(pathname);
  const target = norm(href);
  const active = here === target || (target !== "/icms/dashboard" && here.startsWith(target + "/"));

  if (variant === "bottom") {
    return (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
      >
        {icon}
        <span className="truncate">{label}</span>
      </Link>
    );
  }
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-muted"}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Link>
  );
}
