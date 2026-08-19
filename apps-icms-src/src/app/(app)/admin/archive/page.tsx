import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/status-badge";
import { DirectionBadge } from "@/components/direction-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import type { Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Archive" };
export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
}

export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireRole(["supervisor"]);
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("transactions")
    .select("*, seals(seal_number)")
    .eq("archived", true)
    .order("archived_at", { ascending: false })
    .limit(500);

  const q = params.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_(),]/g, "")}%`;
    query = query.or(
      [
        `transaction_number.ilike.${like}`,
        `vehicle_number.ilike.${like}`,
        `driver_name.ilike.${like}`,
      ].join(",")
    );
  }

  const { data } = await query;
  const transactions = (data ?? []) as unknown as (Transaction & {
    seals: { seal_number: string }[];
  })[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Archive</h1>
        <p className="text-sm text-muted-foreground">
          Transactions archived by a previous Export &amp; Reset Week. Nothing here is ever deleted.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div className="flex-1 space-y-1">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Transaction no, vehicle, driver…"
              />
            </div>
            <Button type="submit">Search</Button>
            <Link href="/admin/archive">
              <Button variant="ghost" type="button">
                Reset
              </Button>
            </Link>
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
              <TableHead>Archived</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No archived transactions match your search.
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
                    {t.archived_at ? formatDateTime(t.archived_at) : "—"}
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
