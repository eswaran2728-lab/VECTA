"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { STATIONS, TEAMS, REPORT_META, SEC016_CHECKED_OPTIONS } from "@/lib/reference-data";
import { sec016Schema } from "@/lib/schemas/sec016";
import { submitSec016 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  RadioGroupField,
  CheckboxGroupField,
  FieldRow,
  FormSection,
} from "@/components/forms/fields";
import { SubmissionConfirmation } from "@/components/forms/SubmissionConfirmation";
import { SmartInputSec016 } from "@/components/forms/SmartInputSec016";
import type { Profile } from "@/lib/types";

interface UIValues {
  station: string;
  team: string;
  staff_name: string;
  staff_no: string;
  duty_date: string;
  duty_hour: string;

  flight: string;
  origin_arr_dep: string;
  assisted_by: string;
  aircraft_type: "A 320" | "A 321" | "A 330" | "Other";
  aircraft_type_other: string;
  reg_no: string;
  sta_std: string;
  ata_atd: string;
  bay_no: string;
  reason_for_delay: string;
  do_infmd: "YES" | "NO";
  inbound_baggage: string;
  outbound_baggage: string;
  inbound_cargo: string;
  outbound_cargo: string;
  inbound_co_mail: string;
  outbound_co_mail: string;
  checked_items: string[];
  shift_leader: string;
  ramp_staff_1: string;
  ramp_staff_2: string;
  ramp_staff_3: string;
  ramp_staff_4: string;
  ramp_staff_5: string;
  cargo_hold_checked: "YES" | "NO";
  staff_frisked: "YES" | "NO";
  discrepancies: string;

  offload_flight_no: string;
  offload_destination: string;
  offload_baggage_tag_no: string;
  offload_total_baggage: string;
  offload_remark: string;
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec016") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    staff_no: profile.staff_no,
    duty_date: "",
    duty_hour: "",
    flight: "",
    origin_arr_dep: "",
    assisted_by: "",
    aircraft_type: "A 320",
    aircraft_type_other: "",
    reg_no: "",
    sta_std: "",
    ata_atd: "",
    bay_no: "",
    reason_for_delay: "",
    do_infmd: "NO",
    inbound_baggage: "",
    outbound_baggage: "",
    inbound_cargo: "",
    outbound_cargo: "",
    inbound_co_mail: "",
    outbound_co_mail: "",
    checked_items: [],
    shift_leader: "",
    ramp_staff_1: "",
    ramp_staff_2: "",
    ramp_staff_3: "",
    ramp_staff_4: "",
    ramp_staff_5: "",
    cargo_hold_checked: "NO",
    staff_frisked: "NO",
    discrepancies: "",
    offload_flight_no: "",
    offload_destination: "",
    offload_baggage_tag_no: "",
    offload_total_baggage: "",
    offload_remark: "",
  };
}

export function Sec016Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec016;
  const [result, setResult] = useState<
    { kind: "submitted"; id: string; submittedAt?: string } | { kind: "queued" } | null
  >(null);
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const values = watch();
  const { savedAt } = useDraftAutosave("sec016", values);
  const { submit } = useOfflineSubmit("sec016", submitSec016);

  const onSubmit = handleSubmit(async (v) => {
    const parsed = sec016Schema.safeParse(v);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(parsed.data);
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec016");
      setResult({ kind: "submitted", id: outcome.id, submittedAt: outcome.submittedAt });
    } else if (outcome.kind === "queued") {
      clearLocalDraft("sec016");
      setResult({ kind: "queued" });
    } else {
      alert(outcome.message);
    }
  });

  if (result) {
    return (
      <SubmissionConfirmation
        reportName={meta.name}
        formCode={meta.code}
        id={result.kind === "submitted" ? result.id : undefined}
        submittedAt={result.kind === "submitted" ? result.submittedAt : undefined}
        queued={result.kind === "queued"}
        onSubmitAnother={() => {
          reset(buildDefaults(profile));
          setAutoFilledFields(new Set());
          setResult(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <SmartInputSec016 setValue={setValue} onParsed={setAutoFilledFields} />

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={STATIONS} error={errors.station} />
          <SelectField name="team" register={register} label="Team" required options={TEAMS} error={errors.team} />
        </FieldRow>
        <FieldRow>
          <TextField name="staff_name" register={register} label="Name" required error={errors.staff_name} />
          <TextField name="staff_no" register={register} label="Staff No" required error={errors.staff_no} />
        </FieldRow>
        <FieldRow>
          <TextField name="duty_date" type="date" register={register} label="Date" required error={errors.duty_date as never} autoFilled={autoFilledFields.has("duty_date")} />
          <TextField name="duty_hour" type="time" register={register} label="Duty Hour" required error={errors.duty_hour as never} />
        </FieldRow>
      </FormSection>

      <FormSection title="Aircraft">
        <FieldRow>
          <TextField name="flight" register={register} label="Flight" required error={errors.flight} autoFilled={autoFilledFields.has("flight")} />
          <TextField name="origin_arr_dep" register={register} label="Origin Arr / Dep" required error={errors.origin_arr_dep} autoFilled={autoFilledFields.has("origin_arr_dep")} />
        </FieldRow>
        <TextField name="assisted_by" register={register} label="Assisted By" required error={errors.assisted_by} />

        <RadioGroupField
          name="aircraft_type"
          register={register}
          label="Aircraft Type"
          required
          columns={4}
          options={["A 320", "A 321", "A 330", "Other"]}
          error={errors.aircraft_type as never}
        />
        {values.aircraft_type === "Other" && (
          <TextField
            name="aircraft_type_other"
            register={register}
            label="Specify aircraft type"
            required
            error={errors.aircraft_type_other}
          />
        )}

        <FieldRow>
          <TextField name="reg_no" register={register} label="Reg No" required error={errors.reg_no} autoFilled={autoFilledFields.has("reg_no")} />
          <TextField name="bay_no" register={register} label="Bay No" required error={errors.bay_no} autoFilled={autoFilledFields.has("bay_no")} />
        </FieldRow>
        <FieldRow>
          <TextField name="sta_std" type="time" register={register} label="STA / STD" required error={errors.sta_std as never} autoFilled={autoFilledFields.has("sta_std")} />
          <TextField name="ata_atd" type="time" register={register} label="ATA / ATD" required error={errors.ata_atd as never} autoFilled={autoFilledFields.has("ata_atd")} />
        </FieldRow>
        <TextField name="reason_for_delay" register={register} label="Reason for Delay" error={errors.reason_for_delay} autoFilled={autoFilledFields.has("reason_for_delay")} />
        <RadioGroupField name="do_infmd" register={register} label="D/O INFMD" required options={["YES", "NO"]} error={errors.do_infmd as never} />

        <FieldRow>
          <TextField name="inbound_baggage" register={register} label="Inbound Baggage" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.inbound_baggage} />
          <TextField name="outbound_baggage" register={register} label="Outbound Baggage" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.outbound_baggage} />
        </FieldRow>
        <FieldRow>
          <TextField name="inbound_cargo" register={register} label="Inbound Cargo" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.inbound_cargo} />
          <TextField name="outbound_cargo" register={register} label="Outbound Cargo" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.outbound_cargo} />
        </FieldRow>
        <FieldRow>
          <TextField name="inbound_co_mail" register={register} label="Inbound Co-Mail / Comart" required naFillable setValue={setValue} error={errors.inbound_co_mail} />
          <TextField name="outbound_co_mail" register={register} label="Outbound Co-Mail / Comart" required naFillable setValue={setValue} error={errors.outbound_co_mail} />
        </FieldRow>

        <CheckboxGroupField
          name="checked_items"
          register={register}
          label='For long layover / night-stop flights — "CHECKED?"'
          required
          options={SEC016_CHECKED_OPTIONS}
          error={errors.checked_items as never}
        />

        <TextField name="shift_leader" register={register} label="Shift Leader (Ground Handler)" hint="Name & ID" required error={errors.shift_leader} />
        <FieldRow>
          <TextField name="ramp_staff_1" register={register} label="Ramp Staff (Handler 1)" hint="Name & ID" required error={errors.ramp_staff_1} autoFilled={autoFilledFields.has("ramp_staff_1")} />
          <TextField name="ramp_staff_2" register={register} label="Ramp Staff (Handler 2)" hint="Name & ID" required naFillable setValue={setValue} error={errors.ramp_staff_2} autoFilled={autoFilledFields.has("ramp_staff_2")} />
        </FieldRow>
        <FieldRow>
          <TextField name="ramp_staff_3" register={register} label="Ramp Staff (Handler 3)" hint="Name & ID" required naFillable setValue={setValue} error={errors.ramp_staff_3} autoFilled={autoFilledFields.has("ramp_staff_3")} />
          <TextField name="ramp_staff_4" register={register} label="Ramp Staff (Handler 4)" hint="Name & ID" required naFillable setValue={setValue} error={errors.ramp_staff_4} autoFilled={autoFilledFields.has("ramp_staff_4")} />
        </FieldRow>
        <TextField name="ramp_staff_5" register={register} label="Ramp Staff (Handler 5)" hint="Name & ID" required naFillable setValue={setValue} error={errors.ramp_staff_5} autoFilled={autoFilledFields.has("ramp_staff_5")} />

        <FieldRow>
          <RadioGroupField name="cargo_hold_checked" register={register} label="Cargo Hold Checked" required options={["YES", "NO"]} error={errors.cargo_hold_checked as never} />
          <RadioGroupField name="staff_frisked" register={register} label="Staff Frisked" required options={["YES", "NO"]} error={errors.staff_frisked as never} autoFilled={autoFilledFields.has("staff_frisked")} />
        </FieldRow>

        <TextAreaField name="discrepancies" register={register} label="Discrepancies (if any)" required rows={3} error={errors.discrepancies} />
      </FormSection>

      <FormSection title="Offload Information (Departure Flight)">
        <FieldRow>
          <TextField name="offload_flight_no" register={register} label="Flight No" required naFillable setValue={setValue} error={errors.offload_flight_no} />
          <TextField name="offload_destination" register={register} label="Destination" required naFillable setValue={setValue} error={errors.offload_destination} />
        </FieldRow>
        <FieldRow>
          <TextField name="offload_baggage_tag_no" register={register} label="Baggage Tag No" required naFillable setValue={setValue} error={errors.offload_baggage_tag_no} />
          <TextField name="offload_total_baggage" register={register} label="Total Baggage" required naFillable setValue={setValue} error={errors.offload_total_baggage} />
        </FieldRow>
        <TextAreaField name="offload_remark" register={register} label="Remark" required error={errors.offload_remark} />
      </FormSection>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">
          {savedAt ? `Draft saved ${savedAt.toLocaleTimeString()}` : "Autosaving…"}
        </p>
        <button type="submit" className="btn-primary" disabled={isSubmitting}>
          {isSubmitting ? "Submitting…" : "Submit report"}
        </button>
      </div>
    </form>
  );
}
