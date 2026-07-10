import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DIRECTION_LABELS, STATUS_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import type { Transaction, TransactionStatus } from "@/lib/database.types";

export const metadata: Metadata = { title: "Transactions" };
export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const profile = await requireProfile();
  const supabase = await createClient();

  let query = supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  const q = params.q?.trim();
  if (q) {
    // Search across number, vehicle, driver name/id and seal.
    const like = `%${q.replace(/[%_]/g, "")}%`;
    query = query.or(
      `transaction_number.ilike.${like},vehicle_number.ilike.${like},driver_name.ilike.${like},driver_id.ilike.${like},seal_number.ilike.${like}`
    );
  }
  if (params.status && params.status in STATUS_LABELS) {
    query = query.eq("status", params.status as TransactionStatus);
  }
  if (params.from) {
    query = query.gte("created_at", new Date(`${params.from}T00:00:00`).toISOString());
  }
  if (params.to) {
    query = query.lte("created_at", new Date(`${params.to}T23:59:59`).toISOString());
  }

  const { data } = await query;
  const transactions = (data ?? []) as Transaction[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            {profile.role === "warehouse_pic"
              ? "Your created transactions."
              : "All catering security movements."}
          </p>
        </div>
        {profile.role === "warehouse_pic" ? (
          <Link href="/transactions/new">
            <Button size="lg">+ New Transaction</Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1 lg:col-span-2">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Transaction no, vehicle, driver, driver ID, seal…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue={params.status ?? ""}>
                <option value="">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={params.from ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={params.to ?? ""} />
            </div>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
              <Button type="submit">Apply filters</Button>
              <Link href="/transactions">
                <Button variant="ghost" type="button">
                  Reset
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Seal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No transactions match your filters.
                </TableCell>
              </TableRow>
            ) : (
              transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link
                      href={`/transactions/${t.id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {t.transaction_number}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {DIRECTION_LABELS[t.direction]}
                  </TableCell>
                  <TableCell className="font-mono">{t.vehicle_number}</TableCell>
                  <TableCell>
                    {t.driver_name}
                    <span className="block text-xs text-muted-foreground">{t.driver_id}</span>
                  </TableCell>
                  <TableCell className="font-mono">{t.seal_number}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
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
    </div>
  );
}
