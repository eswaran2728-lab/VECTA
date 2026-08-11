import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { toggleWhitelistRow, updatePassExpiry } from "@/lib/actions/whitelists";
import { AddCompanyForm, AddDriverForm, AddVehicleForm, DeleteRowButton } from "./whitelist-forms";
import type { CateringCompany, DriverRecord, VehicleRecord } from "@/lib/database.types";

export const metadata: Metadata = { title: "Whitelists" };
export const dynamic = "force-dynamic";

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge
      className={
        active
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          : "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
      }
    >
      {active ? "Active" : "Deactivated"}
    </Badge>
  );
}

function ToggleForm({ table, id, active }: { table: string; id: string; active: boolean }) {
  return (
    <form action={toggleWhitelistRow}>
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <button type="submit" className="text-xs text-primary underline">
        {active ? "Deactivate" : "Reactivate"}
      </button>
    </form>
  );
}

function ExpiryCell({
  table,
  id,
  value,
}: {
  table: string;
  id: string;
  value: string | null;
}) {
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

export default async function WhitelistsPage() {
  await requireRole(["supervisor"]);
  const supabase = await createClient();

  const [companiesRes, vehiclesRes, driversRes] = await Promise.all([
    supabase.from("catering_companies").select("*").order("name"),
    supabase.from("vehicles").select("*, catering_companies(name)").order("vehicle_number"),
    supabase.from("drivers").select("*, catering_companies(name)").order("name"),
  ]);

  const companies = (companiesRes.data ?? []) as CateringCompany[];
  const vehicles = (vehiclesRes.data ?? []) as unknown as (VehicleRecord & {
    catering_companies: { name: string } | null;
  })[];
  const drivers = (driversRes.data ?? []) as unknown as (DriverRecord & {
    catering_companies: { name: string } | null;
  })[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Whitelists</h1>
        <p className="text-sm text-muted-foreground">
          Approved catering companies, vehicles and drivers. These are hard gates, not soft
          warnings: a vehicle or driver not listed and active here is blocked from creating a
          transaction (Part A) and from passing Post 2/Post 6 checkpoints. Entries are
          deactivated, never deleted; every change is audit-logged.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catering Companies ({companies.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddCompanyForm />
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
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono">{c.code}</TableCell>
                  <TableCell>
                    <ActiveBadge active={c.is_active} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(c.created_at)}
                  </TableCell>
                  <TableCell>
                    <ToggleForm table="catering_companies" id={c.id} active={c.is_active} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vehicles ({vehicles.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddVehicleForm companies={companies.filter((c) => c.is_active)} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Pass No.</TableHead>
                <TableHead>Pass Expiry</TableHead>
                <TableHead>Truck Type</TableHead>
                <TableHead>Truck Reg. No.</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {vehicles.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono font-medium">{v.vehicle_number}</TableCell>
                  <TableCell>{v.catering_companies?.name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.airport_pass_number ?? "—"}
                  </TableCell>
                  <TableCell>
                    <ExpiryCell table="vehicles" id={v.id} value={v.pass_expiry_date} />
                  </TableCell>
                  <TableCell className="text-xs">{v.truck_type ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.truck_registration_number ?? "—"}
                  </TableCell>
                  <TableCell>
                    <ActiveBadge active={v.is_active} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ToggleForm table="vehicles" id={v.id} active={v.is_active} />
                      <DeleteRowButton table="vehicles" id={v.id} label={v.vehicle_number} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Drivers ({drivers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AddDriverForm companies={companies.filter((c) => c.is_active)} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Staff ID</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Pass No.</TableHead>
                <TableHead title="ADP Expiry Date">ADP Expiry Date</TableHead>
                <TableHead>IC Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {drivers.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell className="font-mono">{d.staff_id}</TableCell>
                  <TableCell>{d.catering_companies?.name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.airport_pass_number ?? "—"}
                  </TableCell>
                  <TableCell>
                    <ExpiryCell table="drivers" id={d.id} value={d.pass_expiry_date} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.swap_to_staff_ic && d.staff_ic_number ? d.staff_ic_number : "—"}
                  </TableCell>
                  <TableCell>
                    <ActiveBadge active={d.is_active} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ToggleForm table="drivers" id={d.id} active={d.is_active} />
                      <DeleteRowButton
                        table="drivers"
                        id={d.id}
                        label={`${d.name} (${d.staff_id})`}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
