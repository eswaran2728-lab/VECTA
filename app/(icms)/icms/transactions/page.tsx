import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/icms/status-badge";
import { DirectionBadge } from "@/components/icms/direction-badge";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";
import { Input } from "@/components/icms/ui/input";
import { Label } from "@/components/icms/ui/label";
import { Select } from "@/components/icms/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/icms/ui/table";
import { STATUS_LABELS } from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import type { Transaction, TransactionStatus } from "@/lib/icms/database.types";
import { nextStepFor } from "@/lib/icms/workflow";

export const metadata: Metadata = { title: "Transactions" };
export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  status?: string;
  direction?: string;
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
    .select("*, seals(seal_number)")
    .eq("archived", false)
    .order("created_at", { ascending: false })
    .limit(200);

  const q = params.q?.trim();
  if (q) {
    // Search across number, vehicle, driver name/id, flight, legacy seal
    // column, and the seals table (matched via transaction ids).
    const like = `%${q.replace(/[%_(),]/g, "")}%`;
    const { data: sealHits } = await supabase
      .from("seals")
      .select("transaction_id")
      .ilike("seal_number", like)
      .limit(100);
    const sealIds = [...new Set((sealHits ?? []).map((s) => s.transaction_id))];
    const parts = [
      `transaction_number.ilike.${like}`,
      `vehicle_number.ilike.${like}`,
      `driver_name.ilike.${like}`,
      `driver_id.ilike.${like}`,
      `flight_number.ilike.${like}`,
      `seal_number.ilike.${like}`,
    ];
    if (sealIds.length > 0) {
      parts.push(`id.in.(${sealIds.join(",")})`);
    }
    query = query.or(parts.join(","));
  }
  if (params.status && params.status in STATUS_LABELS) {
    query = query.eq("status", params.status as TransactionStatus);
  }
  if (params.direction === "OUTBOUND" || params.direction === "INBOUND") {
    query = query.eq("direction", params.direction);
  }
  if (params.from) {
    query = query.gte("created_at", new Date(`${params.from}T00:00:00`).toISOString());
  }
  if (params.to) {
    query = query.lte("created_at", new Date(`${params.to}T23:59:59`).toISOString());
  }

  const { data } = await query;
  const transactions = ((data ?? []) as unknown as (Transaction & {
    seals: { seal_number: string }[];
  })[]).sort((left, right) => {
    const rank = (transaction: Transaction) => {
      const next = nextStepFor(transaction.direction, transaction.status);
      if (next?.role === profile.role) return 0;
      if (transaction.status !== "COMPLETED" && transaction.status !== "ESCALATED") return 1;
      if (transaction.status === "ESCALATED") return 2;
      return 3;
    };
    return rank(left) - rank(right) || Date.parse(right.created_at) - Date.parse(left.created_at);
  });

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
          <Link href="/icms/transactions/new">
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
                placeholder="Transaction no, vehicle, driver, flight, seal…"
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
              <Label htmlFor="direction">Direction</Label>
              <Select id="direction" name="direction" defaultValue={params.direction ?? ""}>
                <option value="">Both directions</option>
                <option value="OUTBOUND">Outbound</option>
                <option value="INBOUND">Inbound</option>
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
              <Link href="/icms/transactions">
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
              transactions.map((t) => {
                const actionable = nextStepFor(t.direction, t.status)?.role === profile.role;
                return (
                <TableRow key={t.id} className={actionable ? "bg-primary/5 ring-1 ring-inset ring-primary/20" : undefined}>
                  <TableCell>
                    <Link
                      href={`/icms/transactions/${t.id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {t.transaction_number}
                    </Link>
                    {actionable ? (
                      <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        Your turn
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <DirectionBadge direction={t.direction} />
                  </TableCell>
                  <TableCell className="font-mono">{t.vehicle_number}</TableCell>
                  <TableCell>
                    {t.driver_name}
                    <span className="block text-xs text-muted-foreground">{t.driver_id}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {t.seals.length > 0
                      ? t.seals.map((s) => s.seal_number).join(", ")
                      : (t.seal_number ?? "—")}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(t.created_at)}
                  </TableCell>
                </TableRow>
              )})
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
