import Link from "next/link";
import Image from "next/image";
import { landingPathForRole } from "@/lib/auth";
import { APP_NAME } from "@/lib/branding";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { initials } from "@/lib/utils";
import type { Profile } from "@/lib/types";

export function AppHeader({
  profile,
  title,
  backHref,
}: {
  profile: Profile;
  title?: string;
  backHref?: string;
}) {
  const subtitle = `${profile.name} · ${profile.station}${profile.team ? ` · ${profile.team}` : ""}`;

  return (
    <header
      className="sticky top-0 z-30"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)" }}
    >
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {backHref && (
            <Link
              href={backHref}
              aria-label="Back"
              className="t-mono text-[15px] font-semibold shrink-0"
              style={{ color: "var(--mid)" }}
            >
              ←
            </Link>
          )}
          <Image
            src="/icons/icon-192.png"
            alt="AVSEC AirAsia"
            width={30}
            height={36}
            className="shrink-0 object-contain"
          />
          <div className="min-w-0">
            <Link
              href={landingPathForRole(profile.role)}
              className="block truncate font-condensed font-bold text-[15px] leading-tight uppercase"
              style={{ letterSpacing: "0.16em", color: "var(--ink)" }}
            >
              {title ?? APP_NAME}
            </Link>
            <p
              className="truncate t-mono text-[9px] font-medium"
              style={{ letterSpacing: "0.1em", color: "var(--gold)" }}
            >
              {subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />
          <Link
            href="/profile"
            aria-label="Profile and settings"
            className="w-[34px] h-[34px] flex items-center justify-center t-mono text-[11px] font-bold"
            style={{ background: "var(--gold-fill)", color: "var(--on-gold)" }}
          >
            {initials(profile.name)}
          </Link>
        </div>
      </div>
    </header>
  );
}
