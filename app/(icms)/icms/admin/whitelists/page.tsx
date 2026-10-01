import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/icms/ui/table";
import { Badge } from "@/components/icms/ui/badge";
import { Input } from "@/components/icms/ui/input";
import { Select } from "@/components/icms/ui/select";
import { Button } from "@/components/icms/ui/button";
import { formatDate } from "@/lib/icms/utils";
import { updatePassExpiry, listWhitelistEntries, listVendorOptions, type WhitelistEntry } from "@/lib/icms/actions/whitelists";
import {
  AddCompanyForm,
  AddDriverForm,
  AddVehicleForm,
  ApproveButton,
  ActivateButton,
  ReasonActionButton,
} from "./whitelist-forms";

export const metadata: Metadata = { title: "Whitelists" };
export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<WhitelistEntry["status"], string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  inactive: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  deactivated: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  expired: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  future: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  revoked: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

function StatusBadge({ status }: { status: WhitelistEntry["status"] }) {
  return <Badge className={STATUS_STYLE[status]}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}

function ExpiryCell({ table, id, value }: { table: string; id: string; value: string | null }) {
  const expired = value !== null && value < new Date().toISOString().slice(0, 10);
  return (
    <form action={updatePassExpiry} className="flex items-center gap-1">
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <input
        type="date"
        name="pass_expiry_date"
        defaultValue={value ?? ""}
        className={`h-8 rounded border bg-background px-1 text-xs ${expired ? "border-red-500 text-red-600" : "border-input"}`}
      />
      <button type="submit" className="text-xs text-primary underline">
        Save
      </button>
    </form>
  );
}

function RowActions({ table, entry }: { table: string; entry: WhitelistEntry }) {
  if (entry.status === "pending") {
    return (
      <div className="flex items-center gap-2">
        <ApproveButton table={table} id={entry.id} />
        <ReasonActionButton table={table} id={entry.id} mode="reject" label="Reject" />
      </div>
    );
  }
  if (entry.status === "active" || entry.status === "expired" || entry.status === "future") {
    return (
      <div className="flex items-center gap-2">
        <ReasonActionButton table={table} id={entry.id} mode="deactivate" label="Deactivate" />
        <ReasonActionButton table={table} id={entry.id} mode="revoke" label="Revoke" />
      </div>
    );
  }
  if (entry.status === "inactive" || entry.status === "deactivated") {
    return (
      <div className="flex items-center gap-2">
        <ActivateButton table={table} id={entry.id} />
        <ReasonActionButton table={table} id={entry.id} mode="revoke" label="Revoke" />
      </div>
    );
  }
  // rejected / revoked: terminal, no further action offered
  return <span className="text-xs text-muted-foreground">{entry.reason ?? "—"}</span>;
}

export default async function WhitelistsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { q, status } = await searchParams;
  const search = (q ?? "").trim() || undefined;
  const statusFilter = (status ?? "").trim() || undefined;

  const [companiesRes, vehiclesRes, driversRes, vendorOptions] = await Promise.all([
    listWhitelistEntries({ entryType: "vendor", search, status: statusFilter }),
    listWhitelistEntries({ entryType: "vehicle", search, status: statusFilter }),
    listWhitelistEntries({ entryType: "driver", search, status: statusFilter }),
    listVendorOptions(),
  ]);

  if (companiesRes.unauthorized) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <h1 className="text-lg font-semibold">Not authorized</h1>
        <p className="mt-1">
          Managing the CaterLink whitelist requires an active CaterLink Management assignment
          for your Area of Operational Control. Contact an administrator to be granted this role.
        </p>
      </div>
    );
  }

  const companies = companiesRes.entries;
  const vehicles = vehiclesRes.entries;
  const drivers = driversRes.entries;
  const loadError = companiesRes.error || vehiclesRes.error || driversRes.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Whitelists</h1>
        <p className="text-sm text-muted-foreground">
          Approved catering companies, vehicles and drivers. These are hard gates, not soft
          warnings: a vehicle or driver not listed and active here is blocked from creating a
          transaction (Part A) and from passing Post 2/Post 6 checkpoints. New entries require
          CaterLink Management approval before they take effect. Entries are deactivated, never
          deleted; every change is audit-logged.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <Input name="q" placeholder="Search name, code, plate, staff ID…" defaultValue={q ?? ""} className="w-64" />
        <Select name="status" defaultValue={status ?? ""} className="w-40">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="future">Future (not yet effective)</option>
          <option value="deactivated">Deactivated</option>
          <option value="inactive">Inactive (legacy)</option>
          <option value="rejected">Rejected</option>
          <option value="revoked">Revoked</option>
        </Select>
        <Button type="submit" size="sm">
          Filter
        </Button>
      </form>

      {loadError ? (
        <p className="text-sm text-red-600">Failed to load whitelist: {loadError}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catering Companies ({companies.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddCompanyForm />
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching vendor entries.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Since</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.display_name}</TableCell>
                    <TableCell className="font-mono">{c.identifier}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(c.created_at)}
                    </TableCell>
                    <TableCell>
                      <RowActions table="catering_companies" entry={c} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vehicles ({vehicles.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddVehicleForm companies={vendorOptions} />
          {vehicles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching vehicle entries.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Pass Expiry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {vehicles.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono font-medium">{v.identifier}</TableCell>
                    <TableCell>{v.company_name ?? "—"}</TableCell>
                    <TableCell>
                      <ExpiryCell table="vehicles" id={v.id} value={v.pass_expiry_date} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={v.status} />
                    </TableCell>
                    <TableCell>
                      <RowActions table="vehicles" entry={v} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Drivers ({drivers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddDriverForm companies={vendorOptions} />
          {drivers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching driver entries.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Staff ID</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead title="ADP Expiry Date">ADP Expiry Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {drivers.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.display_name}</TableCell>
                    <TableCell className="font-mono">{d.identifier}</TableCell>
                    <TableCell>{d.company_name ?? "—"}</TableCell>
                    <TableCell>
                      <ExpiryCell table="drivers" id={d.id} value={d.pass_expiry_date} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell>
                      <RowActions table="drivers" entry={d} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
