"use client";

import { useActionState, useState } from "react";
import {
  addCompany,
  addDriver,
  addVehicle,
  type WhitelistActionState,
} from "@/lib/actions/whitelists";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { CateringCompany, TruckType } from "@/lib/database.types";

const initialState: WhitelistActionState = { error: null, success: null };
const TRUCK_TYPES: TruckType[] = ["Hi-Lift", "Bonded Truck"];

function Feedback({ state }: { state: WhitelistActionState }) {
  if (state.error) return <p className="text-sm text-red-600">{state.error}</p>;
  if (state.success) return <p className="text-sm text-emerald-600">{state.success}</p>;
  return null;
}

export function AddCompanyForm() {
  const [state, action, pending] = useActionState(addCompany, initialState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Input name="name" placeholder="Company name" required className="w-56" />
      <Input name="code" placeholder="Code (e.g. BRH)" required className="w-36" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add company"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

function CompanySelect({
  companies,
  defaultCompanyId,
}: {
  companies: CateringCompany[];
  defaultCompanyId: string;
}) {
  return (
    <Select name="catering_company_id" defaultValue={defaultCompanyId} className="w-48">
      <option value="">No company</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

/** Auto-inserts dashes as the staff types a 12-digit Malaysian IC: XXXXXX-XX-XXXX. */
function formatIc(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  const parts = [digits.slice(0, 6), digits.slice(6, 8), digits.slice(8, 12)].filter(Boolean);
  return parts.join("-");
}

export function AddVehicleForm({ companies }: { companies: CateringCompany[] }) {
  const [state, action, pending] = useActionState(addVehicle, initialState);
  const defaultCompanyId = companies.find((c) => c.code === "IFC")?.id ?? "";
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Input name="vehicle_number" placeholder="Vehicle number" required className="w-40" />
      <CompanySelect companies={companies} defaultCompanyId={defaultCompanyId} />
      <Input name="airport_pass_number" placeholder="Pass no." className="w-32" />
      <Input name="pass_expiry_date" type="date" className="w-40" />
      <Select name="truck_type" defaultValue="" required className="w-36" title="Truck type">
        <option value="" disabled>
          Truck type…
        </option>
        {TRUCK_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      <Input name="truck_registration_number" placeholder="Truck reg. no." className="w-36" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add vehicle"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function AddDriverForm({ companies }: { companies: CateringCompany[] }) {
  const [state, action, pending] = useActionState(addDriver, initialState);
  const defaultCompanyId = companies.find((c) => c.code === "IFC")?.id ?? "";
  const [swapToStaffIc, setSwapToStaffIc] = useState(false);
  const [staffIc, setStaffIc] = useState("");

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Input name="name" placeholder="Driver name" required className="w-48" />
      <Input name="staff_id" placeholder="Staff ID" required className="w-32" />
      <CompanySelect companies={companies} defaultCompanyId={defaultCompanyId} />
      <Input name="airport_pass_number" placeholder="Pass no." className="w-32" />
      <Input
        name="pass_expiry_date"
        type="date"
        className="w-40"
        title="Airport Pass Expiry Date — used to track when the staff's airport pass expires."
      />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          name="swap_to_staff_ic"
          checked={swapToStaffIc}
          onChange={(e) => {
            setSwapToStaffIc(e.target.checked);
            if (!e.target.checked) setStaffIc("");
          }}
          className="h-4 w-4 accent-primary"
        />
        Swap to Staff IC
      </label>
      {swapToStaffIc ? (
        <Input
          name="staff_ic_number"
          placeholder="XXXXXX-XX-XXXX"
          value={staffIc}
          onChange={(e) => setStaffIc(formatIc(e.target.value))}
          pattern="\d{6}-\d{2}-\d{4}"
          required
          className="w-36 font-mono"
        />
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add driver"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
