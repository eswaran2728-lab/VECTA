import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/icms/ui/badge";
import { Button } from "@/components/icms/ui/button";
import { Card } from "@/components/icms/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/icms/ui/table";
import { VENDOR_STATUS_COLORS, VENDOR_STATUS_LABELS } from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import type { VendorTransaction } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Vendor Deliveries" };
export const dynamic = "force-dynamic";

export default async function VendorTransactionsPage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  // RLS already scopes this: a vendor sees only their own rows
  // (vendor_transactions: vendor reads own), while checkpoint/management
  // roles see everything (vendor_transactions: checkpoint roles read all) —
  // see supabase/migrations/icms/20260813000002_vendor_movement.sql and
  // management_icms_parity.sql.
  const { data } = await supabase
    .from("vendor_transactions")
    .select("*, vendor_part_a(driver_name, seal_number)")
    .order("created_at", { ascending: false })
    .limit(200);

  const transactions = (data ?? []) as unknown as (VendorTransaction & {
    vendor_part_a: { driver_name: string; seal_number: string }[];
  })[];

  const isVendor = profile.role === "vendor";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isVendor ? "My Deliveries" : "Vendor Deliveries"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isVendor
              ? "Vendor movement transactions you've created."
              : "All vendor-supplied movement transactions (AA/SEC/F/019)."}
          </p>
        </div>
        {isVendor ? (
          <Link href="/icms/vendor-transactions/new">
            <Button size="lg">+ New Delivery</Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Seal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {isVendor
                    ? "You haven't created any deliveries yet."
                    : "No vendor deliveries yet."}
                </TableCell>
              </TableRow>
            ) : (
              transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link
                      href={`/icms/vendor-transactions/${t.id}`}
                      prefetch={false}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {t.transaction_number}
                    </Link>
                  </TableCell>
                  <TableCell>{t.vendor_part_a[0]?.driver_name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {t.vendor_part_a[0]?.seal_number ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge className={VENDOR_STATUS_COLORS[t.status]}>
                      {VENDOR_STATUS_LABELS[t.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(t.created_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="h-14" aria-hidden />
    </div>
  );
}
