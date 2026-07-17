"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { STATIONS, TEAMS, REPORT_META, AIRCRAFT_TYPES } from "@/lib/reference-data";
import { sec018Schema } from "@/lib/schemas/sec018";
import { submitSec018 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  CheckboxField,
  FieldRow,
  FormSection,
} from "@/components/forms/fields";
import { SubmissionConfirmation } from "@/components/forms/SubmissionConfirmation";
import { combineDateTimeMY } from "@/lib/datetime";
import type { Profile } from "@/lib/types";

interface UIValues {
  station: string;
  team: string;
  staff_name: string;
  date: string;
  time: string;
  patrols: {
    time_from: string;
    time_to: string;
    parking_bay: string;
    aircraft_type: string;
    reg_no: string;
    description: string;
  }[];
  acknowledgement: boolean;
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec018") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    date: "",
    time: "",
    patrols: [],
    acknowledgement: false,
  };
}

export function Sec018Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec018;
  const [result, setResult] = useState<
    { kind: "submitted"; id: string; submittedAt?: string } | { kind: "queued" } | null
  >(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const { fields, append, remove } = useFieldArray({ control, name: "patrols" });
  const values = watch();
  const { savedAt } = useDraftAutosave("sec018", values);
  const { submit } = useOfflineSubmit("sec018", submitSec018);

  const onSubmit = handleSubmit(async (v) => {
    const payload = {
      station: v.station,
      team: v.team,
      staff_name: v.staff_name,
      date_time: combineDateTimeMY(v.date, v.time),
      acknowledgement: v.acknowledgement,
      patrols: v.patrols.map((p) => ({
        time_from: p.time_from || null,
        time_to: p.time_to || null,
        parking_bay: p.parking_bay || null,
        aircraft_type: p.aircraft_type || null,
        reg_no: p.reg_no || null,
        description: p.description,
      })),
    };

    const parsed = sec018Schema.safeParse(payload);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(parsed.data);
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec018");
      setResult({ kind: "submitted", id: outcome.id, submittedAt: outcome.submittedAt });
    } else if (outcome.kind === "queued") {
      clearLocalDraft("sec018");
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
          setResult(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={STATIONS} error={errors.station} />
          <SelectField name="team" register={register} label="Team" required options={TEAMS} error={errors.team} />
        </FieldRow>
        <TextField name="staff_name" register={register} label="Name" required error={errors.staff_name} />
        <FieldRow>
          <TextField name="date" type="date" register={register} label="Date" required error={errors.date as never} />
          <TextField name="time" type="time" register={register} label="Time" required error={errors.time as never} />
        </FieldRow>
      </FormSection>

      <FormSection title="Patrolling Details" note="Add each patrol entry — up to 6 per shift.">
        <div className="space-y-4">
          {fields.map((field, idx) => (
            <div key={field.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-sm">Entry {idx + 1}</p>
                <button type="button" className="btn-quiet text-red-600" onClick={() => remove(idx)}>
                  Remove
                </button>
              </div>
              <FieldRow>
                <TextField name={`patrols.${idx}.time_from`} type="time" register={register} label="Time From" error={errors.patrols?.[idx]?.time_from as never} />
                <TextField name={`patrols.${idx}.time_to`} type="time" register={register} label="Time To" error={errors.patrols?.[idx]?.time_to as never} />
              </FieldRow>
              <FieldRow>
                <TextField name={`patrols.${idx}.parking_bay`} register={register} label="A/C Parking Bay" error={errors.patrols?.[idx]?.parking_bay} />
                <SelectField
                  name={`patrols.${idx}.aircraft_type`}
                  register={register}
                  label="Aircraft Type"
                  options={[...AIRCRAFT_TYPES, "Other"]}
                  error={errors.patrols?.[idx]?.aircraft_type}
                />
              </FieldRow>
              <TextField name={`patrols.${idx}.reg_no`} register={register} label="Reg. No" error={errors.patrols?.[idx]?.reg_no} />
              <TextAreaField name={`patrols.${idx}.description`} register={register} label="Description / Report" error={errors.patrols?.[idx]?.description} />
            </div>
          ))}
          {fields.length < 6 && (
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() =>
                append({
                  time_from: "",
                  time_to: "",
                  parking_bay: "",
                  aircraft_type: "",
                  reg_no: "",
                  description: "",
                })
              }
            >
              + Add Patrol Entry ({fields.length}/6)
            </button>
          )}
        </div>
      </FormSection>

      <CheckboxField
        name="acknowledgement"
        register={register}
        label="The information provided as true and correct."
        error={errors.acknowledgement}
      />

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
