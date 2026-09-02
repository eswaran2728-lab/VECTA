import Link from "next/link";
import {
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  PlusCircle,
  ScanLine,
  ShieldAlert,
  FileBarChart,
  Users,
  ScrollText,
  Archive,
} from "lucide-react";
import { requireProfile } from "@/lib/icms/auth";
import { signOut } from "@/lib/icms/actions/auth";
import { getLang } from "@/lib/icms/actions/language";
import { LanguageToggle } from "@/components/icms/language-toggle";
import { ROLE_LABELS } from "@/lib/icms/constants";
import { ThemeToggle } from "@/components/icms/theme-toggle";
import { NotificationsBell } from "@/components/icms/notifications-bell";
import { PwaProvider } from "@/components/icms/pwa-provider";
import { InstallPrompt } from "@/components/icms/install-prompt";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import type { OpsGroup } from "@/lib/icms/database.types";

const ORG_WIDE_UNIFIED_ROLES = ["admin", "management", "enforcement"];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();
  const lang = await getLang();

  const isPic = profile.role === "warehouse_pic";
  const isVendor = profile.role === "vendor";
  // warehouse_pic scans too now, for Vendor Movement Part C — not a
  // catering checkpoint of their own, but still needs the Scan nav item.
  // hub_avsec/redq_avsec scan for their own Multi-Route checkpoints.
  const canScan = [
    "post2_avsec",
    "post6_avsec",
    "receiver",
    "warehouse_pic",
    "hub_avsec",
    "redq_avsec",
  ].includes(profile.role);

  // Desktop-only secondary nav — admin sub-pages (Users/Whitelists/Audit/
  // Archive) and the create-transaction shortcuts have no other entry point
  // in the app, so this stays even though the top header and bottom nav
  // below are now the shared, unified ones (UnifiedHeader/TeamBottomNav) —
  // this row is ICMS-specific content under the shared chrome, not a
  // competing header of its own.
  const nav = [
    { href: "/icms/dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    { href: "/icms/transactions/new", label: "New", icon: PlusCircle, show: isPic },
    {
      href: "/icms/vendor-transactions/new",
      label: "New Delivery",
      icon: PlusCircle,
      show: isVendor,
    },
    { href: "/icms/scan", label: "Scan", icon: ScanLine, show: canScan },
    { href: "/icms/transactions", label: "Transactions", icon: ClipboardList, show: true },
    { href: "/icms/incidents", label: "Incidents", icon: ShieldAlert, show: true },
    {
      href: "/icms/reports",
      label: "Reports",
      icon: FileBarChart,
      show: profile.role === "supervisor" || profile.role === "enforcement" || profile.role === "management",
    },
    { href: "/icms/admin/users", label: "Users", icon: Users, show: profile.role === "supervisor" },
    {
      href: "/icms/admin/whitelists",
      label: "Whitelists",
      icon: ListChecks,
      show: profile.role === "supervisor",
    },
    {
      href: "/icms/admin/audit",
      label: "Audit Log",
      icon: ScrollText,
      show: profile.role === "supervisor",
    },
    { href: "/icms/admin/archive", label: "Archive", icon: Archive, show: profile.role === "supervisor" },
  ].filter((item) => item.show);

  const orgWide = ORG_WIDE_UNIFIED_ROLES.includes(profile.unified_role ?? "");

  return (
    <div className="flex min-h-screen flex-col pb-24">
      <UnifiedHeader
        name={profile.name}
        roleLabel={ROLE_LABELS[profile.role] ?? null}
        signOutAction={signOut}
        extra={
          <>
            <PwaProvider />
            <LanguageToggle lang={lang} />
            <NotificationsBell userId={profile.id} />
            <ThemeToggle />
          </>
        }
      />

      <nav className="hidden items-center gap-1 border-b border-border px-6 py-2 md:flex">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      <InstallPrompt />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>

      <TeamBottomNav opsGroup={(profile.ops_group ?? null) as OpsGroup | null} orgWide={orgWide} />
    </div>
  );
}
