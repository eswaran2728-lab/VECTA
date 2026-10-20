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
  type LucideIcon,
} from "lucide-react";
import { requireProfile } from "@/lib/icms/auth";
import { getCanScanCaterLink } from "@/lib/avsec/auth";
import { signOut } from "@/lib/icms/actions/auth";
import { getLang } from "@/lib/icms/actions/language";
import { LanguageToggle } from "@/components/icms/language-toggle";
import { ROLE_LABELS } from "@/lib/icms/constants";
import { PwaProvider } from "@/components/icms/pwa-provider";
import { InstallPrompt } from "@/components/icms/install-prompt";
import { AppChrome } from "@/components/layout/shell/AppChrome";
import { buildNavModel } from "@/lib/dashboard/nav-capabilities";
import { getCanConfirmCaterLinkReceipt } from "@/lib/avsec/caterlink/receipt-capability";
import { primaryRoleLabel } from "@/lib/auth/role-capabilities";
import { classifyPortalAccess, isCaterLinkOnly, type PortalKind } from "@/lib/auth/caterlink-access";
import { caterLinkNavFor, CATERLINK_ROLE_LABELS, type CaterLinkIconKey } from "@/lib/caterlink/portal-nav";
import { CaterLinkShell } from "@/components/caterlink/CaterLinkShell";


export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();
  const lang = await getLang();

  // CaterLink-only identities (Management / Driver / Third-Party Vendor) get the CaterLink portal chrome: CaterLink
  // branding and CaterLink navigation only. AVSEC officers who legitimately use ICMS pages keep the VECTA shell.
  const portalKind: PortalKind =
    profile.identity === "external"
      ? (profile.role === "vendor" ? "caterlink_vendor" : "caterlink_driver")
      : profile.canonical
        ? classifyPortalAccess(profile.canonical, null).kind
        : "none";
  if (isCaterLinkOnly(portalKind)) {
    const ICONS: Record<CaterLinkIconKey, LucideIcon> = {
      dashboard: LayoutDashboard, new: PlusCircle, transactions: ClipboardList, incidents: ShieldAlert,
      reports: FileBarChart, whitelists: ListChecks, archive: Archive, audit: ScrollText,
    };
    return (
      <CaterLinkShell
        name={profile.name}
        roleLabel={CATERLINK_ROLE_LABELS[portalKind] ?? "CaterLink"}
        nav={caterLinkNavFor(portalKind).map((n) => ({ href: n.href, label: n.label, icon: ICONS[n.icon] }))}
        signOutAction={signOut}
        languageToggle={<LanguageToggle lang={lang} />}
      >
        {children}
      </CaterLinkShell>
    );
  }

  const isPic = profile.role === "warehouse_pic";
  const isVendor = profile.role === "vendor";
  const isDriver = isPic || isVendor;

  // Scanning is a canonical capability (station operator at a scan-capable
  // station); external parties never scan. Display decision only.
  const canScan = profile.canonical ? await getCanScanCaterLink(profile.canonical) : false;

  // For drivers, keep desktop navigation completely streamlined:
  // Create New Transaction & My Dispatches only
  const nav = isDriver
    ? [
        {
          href: isVendor ? "/icms/vendor-transactions/new" : "/icms/transactions/new",
          label: isVendor ? "+ New Delivery" : "+ New Transaction",
          icon: PlusCircle,
          show: true,
        },
        {
          href: isVendor ? "/icms/vendor-transactions" : "/icms/transactions",
          label: isVendor ? "My Deliveries" : "My Dispatches",
          icon: ClipboardList,
          show: true,
        },
        { href: "/icms/dashboard", label: "Catering Operations", icon: LayoutDashboard, show: true },
      ]
    : [
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
        { href: "/icms/admin/users", label: "Users", icon: Users, show: profile.identity !== "canonical" && profile.role === "supervisor" },
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

  // Everyone who reaches this point holds an active canonical assignment (CaterLink-only identities returned above). Navigation is
  // display-only and comes from those canonical roles plus the two server-derived station capabilities.
  const canonical = profile.canonical;
  const canReceive = canonical ? await getCanConfirmCaterLinkReceipt(canonical) : false;
  const navModel = buildNavModel({ roleCodes: canonical?.roleCodes ?? [], canScan, canReceive });
  const roleLabel = (canonical ? primaryRoleLabel(canonical.roleCodes) : null) ?? ROLE_LABELS[profile.role] ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <AppChrome
        userId={profile.id}
        name={profile.name}
        roleLabel={roleLabel}
        model={navModel}
        station={canonical?.stationCode ?? null}
        team={canonical?.teamName ?? null}
        signOutAction={signOut}
      >
        <div className="flex min-h-screen flex-col">
          <div className="flex items-center justify-end gap-2 px-4 pt-3">
            <PwaProvider />
            <LanguageToggle lang={lang} />
          </div>

          {!isDriver && <InstallPrompt />}

          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
        </div>
      </AppChrome>
    </div>
  );
}
