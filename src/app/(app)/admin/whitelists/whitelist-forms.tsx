"use client";

import { useActionState } from "react";
import {
  addCompany,
  addDriver,
  addVehicle,
  type WhitelistActionState,
} from "@/lib/actions/whitelists";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { CateringCompany } from "@/lib/database.types";

const initialState: WhitelistActionState = { error: null, success: null };

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

function CompanySelect({ companies }: { companies: CateringCompany[] }) {
  return (
    <Select name="catering_company_id" defaultValue="" className="w-48">
      <option value="">No company</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

export function AddVehicleForm({ companies }: { companies: CateringCompany[] }) {
  const [state, action, pending] = useActionState(addVehicle, initialState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Input name="vehicle_number" placeholder="Vehicle number" required className="w-40" />
      <CompanySelect companies={companies} />
      <Input name="airport_pass_number" placeholder="Pass no." className="w-32" />
      <Input name="pass_expiry_date" type="date" className="w-40" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add vehicle"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function AddDriverForm({ companies }: { companies: CateringCompany[] }) {
  const [state, action, pending] = useActionState(addDriver, initialState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <Input name="name" placeholder="Driver name" required className="w-48" />
      <Input name="driver_id" placeholder="Driver ID" required className="w-32" />
      <CompanySelect companies={companies} />
      <Input name="airport_pass_number" placeholder="Pass no." className="w-32" />
      <Input name="pass_expiry_date" type="date" className="w-40" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add driver"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}
