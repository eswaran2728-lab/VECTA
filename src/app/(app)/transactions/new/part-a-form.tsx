"use client";

import { useActionState, useMemo, useState } from "react";
import { PlaneTakeoff, PlaneLanding } from "lucide-react";
import { createTransaction, type ActionState } from "@/lib/actions/transactions";
import { WORKFLOWS } from "@/lib/workflow";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { SealEditor, type SealDraft } from "@/components/seal-editor";
import type {
  CateringCompany,
  Direction,
  DriverRecord,
  VehicleRecord,
} from "@/lib/database.types";

const initialState: ActionState = { error: null };

type WhitelistState = "matched" | "expired" | "unlisted" | "empty";

function whitelistHint(state: WhitelistState): { text: string; className: string } | null {
  switch (state) {
    case "matched":
      return { text: "✓ Whitelisted, pass valid", className: "text-emerald-600" };
    case "expired":
      return {
        text: "✕ Whitelisted but airport pass EXPIRED — will be blocked",
        className: "font-semibold text-red-600",
      };
    case "unlisted":
      return {
        text: "⚠ Not in whitelist — remarks become mandatory",
        className: "text-amber-600",
      };
    default:
      return null;
  }
}

interface PartAFormProps {
  picName: string;
  picStaffId: string;
  companies: CateringCompany[];
  vehicles: Pick<VehicleRecord, "vehicle_number" | "pass_expiry_date">[];
  drivers: Pick<DriverRecord, "name" | "driver_id" | "pass_expiry_date">[];
}

const DIRECTION_OPTIONS: {
  value: Direction;
  title: string;
  subtitle: string;
  icon: typeof PlaneTakeoff;
}[] = [
  {
    value: "OUTBOUND",
    title: "Outbound",
    subtitle: "Catering warehouse → aircraft",
    icon: PlaneTakeoff,
  },
  {
    value: "INBOUND",
    title: "Inbound",
    subtitle: "Aircraft → SRA warehouse",
    icon: PlaneLanding,
  },
];

export function PartAForm({
  picName,
  picStaffId,
  companies,
  vehicles,
  drivers,
}: PartAFormProps) {
  const [state, formAction, pending] = useActionState(createTransaction, initialState);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [searchDone, setSearchDone] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverId, setDriverId] = useState("");
  const [seals, setSeals] = useState<SealDraft[]>([
    { seal_number: "", seal_type: "TRUCK_SEAL", seal_color: "" },
  ]);

  const sealsReady =
    seals.length > 0 && seals.every((s) => s.seal_number.trim() !== "" && s.seal_color !== "");
  const today = new Date().toISOString().slice(0, 10);

  const vehicleState: WhitelistState = useMemo(() => {
    const v = vehicleNumber.trim().toUpperCase();
    if (!v) return "empty";
    const rec = vehicles.find((x) => x.vehicle_number.toUpperCase() === v);
    if (!rec) return "unlisted";
    return rec.pass_expiry_date && rec.pass_expiry_date < today ? "expired" : "matched";
  }, [vehicleNumber, vehicles, today]);

  const driverState: WhitelistState = useMemo(() => {
    const d = driverId.trim().toUpperCase();
    if (!d) return "empty";
    const rec = drivers.find((x) => x.driver_id.toUpperCase() === d);
    if (!rec) return "unlisted";
    return rec.pass_expiry_date && rec.pass_expiry_date < today ? "expired" : "matched";
  }, [driverId, drivers, today]);

  const vehicleHint = whitelistHint(vehicleState);
  const driverHint = whitelistHint(driverState);
  const expiredBlocked = state.error?.startsWith("EXPIRED_PASS:") ?? false;

  const flow = direction
    ? ["A · Warehouse", ...WORKFLOWS[direction].map((s) => s.shortLabel)].join("  →  ")
    : null;

  return (
    <div className="space-y-4">
      {/* Step 1 — pick the direction before anything else is shown. */}
      <Card>
        <CardContent className="pt-6">
          <p className="mb-3 text-sm font-semibold">
            Step 1 — Direction
            <span className="ml-2 font-normal text-muted-foreground">
              What kind of movement is this?
            </span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {DIRECTION_OPTIONS.map((opt) => {
              const active = direction === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDirection(opt.value)}
                  aria-pressed={active}
                  className={
                    active
                      ? "flex items-center gap-3 rounded-xl border-2 border-primary bg-primary/10 p-4 text-left transition-all"
                      : "flex items-center gap-3 rounded-xl border-2 border-border bg-card p-4 text-left transition-all hover:border-primary/40 hover:bg-accent"
                  }
                >
                  <div
                    className={
                      active
                        ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                        : "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    }
                  >
                    <opt.icon className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-heading font-bold">{opt.title}</p>
                    <p className="text-xs text-muted-foreground">{opt.subtitle}</p>
                  </div>
                </button>
              );
            })}
          </div>
          {flow ? (
            <p className="mt-3 rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
              {flow}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {direction === null ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Select Outbound or Inbound above to continue.
        </p>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <form action={formAction} className="space-y-5">
              <input type="hidden" name="direction" value={direction} />

              <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="flight_number">Flight Number (optional)</Label>
              <Input id="flight_number" name="flight_number" placeholder="e.g. AK 703" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aircraft_registration">Aircraft Registration (optional)</Label>
              <Input id="aircraft_registration" name="aircraft_registration" placeholder="e.g. 9M-AQD" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catering_company_id">Catering Company</Label>
              <Select id="catering_company_id" name="catering_company_id" defaultValue="">
                <option value="">— Not specified —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="trolley_count">Trolley Count</Label>
              <Input
                id="trolley_count"
                name="trolley_count"
                type="number"
                min={0}
                defaultValue={0}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vehicle_number">Vehicle Number</Label>
              <Input
                id="vehicle_number"
                name="vehicle_number"
                placeholder="e.g. WKD 4521"
                autoCapitalize="characters"
                list="vehicle-whitelist"
                value={vehicleNumber}
                onChange={(e) => setVehicleNumber(e.target.value)}
                required
              />
              <datalist id="vehicle-whitelist">
                {vehicles.map((v) => (
                  <option key={v.vehicle_number} value={v.vehicle_number} />
                ))}
              </datalist>
              {vehicleHint ? (
                <p className={`text-xs ${vehicleHint.className}`}>{vehicleHint.text}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_id">Driver ID</Label>
              <Input
                id="driver_id"
                name="driver_id"
                list="driver-whitelist"
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
                required
              />
              <datalist id="driver-whitelist">
                {drivers.map((d) => (
                  <option key={d.driver_id} value={d.driver_id}>
                    {d.name}
                  </option>
                ))}
              </datalist>
              {driverHint ? (
                <p className={`text-xs ${driverHint.className}`}>{driverHint.text}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_name">Driver Name</Label>
              <Input id="driver_name" name="driver_name" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="escort_officer_name">Escort Officer (optional)</Label>
              <div className="flex gap-2">
                <Input id="escort_officer_name" name="escort_officer_name" placeholder="Name" />
                <Input name="escort_officer_staff_id" placeholder="Staff ID" className="w-32" />
              </div>
            </div>
          </div>

          <SealEditor seals={seals} onChange={setSeals} />
          <input type="hidden" name="seals" value={JSON.stringify(seals)} />

          <BigCheckbox
            id="vehicle_search_completed"
            name="vehicle_search_completed"
            label="Vehicle search completed"
            description="Cab, cargo area and undercarriage inspected before sealing."
            checked={searchDone}
            onCheckedChange={setSearchDone}
            required
          />

          <div className="space-y-2">
            <Label htmlFor="remarks">
              Remarks{" "}
              {vehicleState === "unlisted" || driverState === "unlisted"
                ? "(mandatory — unlisted vehicle/driver)"
                : "(optional)"}
            </Label>
            <Textarea
              id="remarks"
              name="remarks"
              rows={2}
              required={vehicleState === "unlisted" || driverState === "unlisted"}
            />
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">PIC:</span>{" "}
              <span className="font-medium">{picName}</span>{" "}
              <span className="text-muted-foreground">({picStaffId})</span>
            </p>
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error.replace(/^EXPIRED_PASS:\s*/, "")}
            </p>
          ) : null}

          {expiredBlocked ? (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-red-400 bg-red-50 p-3 text-sm dark:bg-red-950/40">
              <input type="checkbox" name="escalate_expired" className="h-5 w-5 accent-red-600" />
              <span>
                Record anyway as an <strong>Expired Pass incident</strong> — the transaction is
                created and immediately escalated to the admin; the vehicle must not proceed.
              </span>
            </label>
          ) : null}

              <Button
                type="submit"
                size="xl"
                className="w-full"
                disabled={pending || !searchDone || !signature || !sealsReady}
              >
                {pending ? "Creating…" : "Create Transaction & Generate QR"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
