import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/icms/ui/badge";
import { Button } from "@/components/icms/ui/button";
import { Card } from "@/components/icms/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/icms/ui/table";
import { formatDateTime } from "@/lib/icms/utils";
import {
  VENDOR_DELIVERY_STATUS_COLORS,
  VENDOR_DELIVERY_STATUS_LABELS,
  type VendorDelivery,
} from "@/lib/caterlink/vendor";

export const metadata: Metadata = { title: "Vendor Deliveries" };
export const dynamic = "force-dynamic";

export default async function VendorTransactionsPage() {
  const profile = await requireProfile();
  const supabase = await createClient();

  // Row-level security scopes this: a Vendor sees only its own deliveries, CaterLink Management sees
  // those in its AOC, and a scan-authorised officer sees those at its station.
  const { data } = await supabase
    .from("caterlink_vendor_deliveries" as never)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  const deliveries = (data ?? []) as unknown as VendorDelivery[];
  const isVendor = profile.role === "vendor";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{isVendor ? "My Deliveries" : "Vendor Deliveries"}</h1>
          <p className="text-sm text-muted-foreground">
            {isVendor ? "Deliveries you have created." : "Third-party vendor deliveries."}
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
              <TableHead>Delivery</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Seal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {isVendor ? "You haven't created any deliveries yet." : "No vendor deliveries yet."}
                </TableCell>
              </TableRow>
            ) : (
              deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Link href={`/icms/vendor-transactions/${d.id}`} prefetch={false} className="font-mono font-medium text-primary hover:underline">
                      {d.delivery_number}
                    </Link>
                  </TableCell>
                  <TableCell>{d.driver_name}</TableCell>
                  <TableCell className="font-mono text-xs">{d.seal_number}</TableCell>
                  <TableCell>
                    <Badge className={VENDOR_DELIVERY_STATUS_COLORS[d.status]}>{VENDOR_DELIVERY_STATUS_LABELS[d.status]}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(d.created_at)}</TableCell>
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
