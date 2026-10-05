// Pure navigation definition for the CaterLink portal (no framework imports). Keys map to icons in the layout.
// The three CaterLink-only identities see ONLY CaterLink destinations: no VECTA dashboard, AVSEC pages, Super
// Admin link or app switcher. Hiding is a convenience; the boundary is enforced server-side.
import type { PortalKind } from "../auth/caterlink-access.ts";

export type CaterLinkIconKey = "dashboard" | "new" | "transactions" | "incidents" | "reports" | "whitelists" | "archive" | "audit";
export interface CaterLinkNavDef {
  href: string;
  label: string;
  icon: CaterLinkIconKey;
}

export const CATERLINK_ROLE_LABELS: Record<string, string> = {
  caterlink_management: "CaterLink Management",
  caterlink_driver: "CaterLink Driver",
  caterlink_vendor: "Third-Party Vendor",
};

export function caterLinkNavFor(kind: PortalKind): CaterLinkNavDef[] {
  switch (kind) {
    case "caterlink_management":
      // Approved management functions: transactions, history, incidents, whitelists, archive, exports / final PDFs.
      return [
        { href: "/icms/dashboard", label: "Dashboard", icon: "dashboard" },
        { href: "/icms/transactions", label: "Transactions", icon: "transactions" },
        { href: "/icms/incidents", label: "Incidents", icon: "incidents" },
        { href: "/icms/reports", label: "Reports", icon: "reports" },
        { href: "/icms/admin/whitelists", label: "Whitelists", icon: "whitelists" },
        { href: "/icms/admin/archive", label: "Archive", icon: "archive" },
        { href: "/icms/admin/audit", label: "Audit Log", icon: "audit" },
      ];
    case "caterlink_driver":
      return [
        { href: "/icms/transactions/new", label: "+ New Transaction", icon: "new" },
        { href: "/icms/transactions", label: "My Dispatches", icon: "transactions" },
        { href: "/icms/dashboard", label: "Catering Operations", icon: "dashboard" },
      ];
    case "caterlink_vendor":
      return [
        { href: "/icms/vendor-transactions/new", label: "+ New Delivery", icon: "new" },
        { href: "/icms/vendor-transactions", label: "My Deliveries", icon: "transactions" },
        { href: "/icms/dashboard", label: "Catering Operations", icon: "dashboard" },
      ];
    default:
      return [];
  }
}
