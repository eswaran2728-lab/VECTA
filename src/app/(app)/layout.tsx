import Link from "next/link";
import {
  ClipboardList,
  LayoutDashboard,
  PlusCircle,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  FileBarChart,
  Users,
  ScrollText,
  LogOut,
} from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { signOut } from "@/lib/actions/auth";
import { ROLE_LABELS } from "@/lib/constants";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();

  const nav = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    {
      href: "/transactions/new",
      label: "New Transaction",
      icon: PlusCircle,
      show: profile.role === "warehouse_pic",
    },
    {
      href: "/scan",
      label: "Scan QR",
      icon: ScanLine,
      show: ["post2_avsec", "post6_avsec", "receiver"].includes(profile.role),
    },
    { href: "/transactions", label: "Transactions", icon: ClipboardList, show: true },
    { href: "/incidents", label: "Incidents", icon: ShieldAlert, show: true },
    {
      href: "/reports",
      label: "Reports",
      icon: FileBarChart,
      show: profile.role === "supervisor",
    },
    {
      href: "/admin/users",
      label: "Users",
      icon: Users,
      show: profile.role === "supervisor",
    },
    {
      href: "/admin/audit",
      label: "Audit Log",
      icon: ScrollText,
      show: profile.role === "supervisor",
    },
  ].filter((item) => item.show);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="hidden sm:inline">CSCS</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
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

          <div className="flex items-center gap-2">
            <div className="hidden text-right text-xs sm:block">
              <p className="font-medium">{profile.name}</p>
              <p className="text-muted-foreground">{ROLE_LABELS[profile.role]}</p>
            </div>
            <ThemeToggle />
            <form action={signOut}>
              <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                <LogOut className="h-5 w-5" />
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-24 md:pb-6">{children}</main>

      {/* Bottom navigation for phones/tablets */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-card md:hidden print:hidden">
        <div className="grid auto-cols-fr grid-flow-col">
          {nav.slice(0, 5).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              <item.icon className="h-5 w-5" />
              {item.label.split(" ")[0]}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
