"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { REPORT_META, SEC013_DUTY_AREAS, SEC013_LOCATIONS, SEC013_CERTIFICATION_TEXT, SECURITY_DISCLAIMER } from "@/lib/reference-data";
import { sec013Schema } from "@/lib/schemas/sec013";
import { submitSec013 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import { combineDateTimeMY } from "@/lib/datetime";
import {
  TextField,
  TextAreaField,
  SelectField,
  CheckboxField,
  FieldRow,
  FormSection,
  FormStepIndicator,
  EntryCard,
  RemarkQuickPhrases,
} from "@/components/forms/fields";
import { SubmissionConfirmation } from "@/components/forms/SubmissionConfirmation";
import type { Profile } from "@/lib/types";

interface UIValues {
  station: string;
  team: string;
  staff_name: string;
  staff_id: string;
  date_in: string;
  time_in: string;
  date_out: string;
  time_out: string;
  profiling_duties: {
    duty_area: string;
    time_from: string;
    time_to: string;
    location: string;
    sector_flight: string;
    description: string;
    incident_remark: string;
  }[];
  remark: string;
  corrective_action: string;
  acknowledgement: boolean;
}

function emptyDuty() {
  return {
    duty_area: "",
    time_from: "",
    time_to: "",
    location: "",
    sector_flight: "",
    description: "",
    incident_remark: "",
  };
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec013") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    staff_id: profile.staff_no,
    date_in: "",
    time_in: "",
    date_out: "",
    time_out: "",
    profiling_duties: [emptyDuty()],
    remark: "",
    corrective_action: "",
    acknowledgement: false,
  };
}

export function Sec013Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec013;
  const [result, setResult] = useState<
    { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string } | { kind: "queued" } | null
  >(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    trigger,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const { fields, append, remove } = useFieldArray({ control, name: "profiling_duties" });
  const values = watch();
  const { savedAt } = useDraftAutosave("sec013", values);
  const { submit } = useOfflineSubmit("sec013", submitSec013);

  const lastIndex = fields.length - 1;

  async function handleAddAnother() {
    const valid = await trigger(
      [
        `profiling_duties.${lastIndex}.duty_area`,
        `profiling_duties.${lastIndex}.time_from`,
        `profiling_duties.${lastIndex}.time_to`,
        `profiling_duties.${lastIndex}.location`,
        `profiling_duties.${lastIndex}.sector_flight`,
        `profiling_duties.${lastIndex}.description`,
      ] as never,
    );
    if (!valid) return;
    append(emptyDuty());
  }

  const onSubmit = handleSubmit(async (v) => {
    const payload = {
      station: v.station,
      team: v.team,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      date_time_in: combineDateTimeMY(v.date_in, v.time_in),
      date_time_out: combineDateTimeMY(v.date_out, v.time_out),
      profiling_duties: v.profiling_duties,
      remark: v.remark,
      corrective_action: v.corrective_action,
      acknowledgement: v.acknowledgement,
    };

    const parsed = sec013Schema.safeParse(payload);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(parsed.data);
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec013");
      setResult({ kind: "submitted", id: outcome.id, submittedAt: outcome.submittedAt, reportNo: outcome.reportNo });
    } else if (outcome.kind === "queued") {
      clearLocalDraft("sec013");
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
        reportNo={result.kind === "submitted" ? result.reportNo : undefined}
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
      <FormStepIndicator
        code={meta.code}
        draftNote={savedAt ? `DRAFT SAVED ${savedAt.toLocaleTimeString()}` : "AUTOSAVING…"}
        steps={["STAFF", "PROFILING", "SUBMIT"]}
        activeIndex={values.acknowledgement ? 2 : 1}
      />

      <p className="disclaimer-band">{SECURITY_DISCLAIMER}</p>

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <TextField name="station" register={register} label="Hub/Station" required error={errors.station} />
          <TextField
            name="team"
            register={register}
            label="Team"
            required
            placeholder="e.g. Alpha"
            error={errors.team}
          />
        </FieldRow>
        <FieldRow>
          <TextField name="staff_name" register={register} label="Name Staff" required error={errors.staff_name} />
          <TextField name="staff_id" register={register} label="Staff ID" required error={errors.staff_id} />
        </FieldRow>
        <FieldRow>
          <TextField name="date_in" type="date" register={register} label="Date In" required error={errors.date_in as never} />
          <TextField name="time_in" type="time" register={register} label="Time In" required error={errors.time_in as never} />
        </FieldRow>
        <FieldRow>
          <TextField name="date_out" type="date" register={register} label="Date Out" required error={errors.date_out as never} />
          <TextField name="time_out" type="time" register={register} label="Time Out" required error={errors.time_out as never} />
        </FieldRow>
      </FormSection>

      <FormSection title="Profiling Duty">
        <div className="space-y-3">
          {fields.map((field, idx) => {
            const timeFrom = values.profiling_duties?.[idx]?.time_from;
            const timeTo = values.profiling_duties?.[idx]?.time_to;
            const crossesMidnight = Boolean(timeFrom && timeTo && timeTo < timeFrom);
            return (
              <EntryCard
                key={field.id}
                label={`Profiling Duty ${idx + 1}`}
                onRemove={fields.length > 1 ? () => remove(idx) : undefined}
              >
                <FieldRow>
                  <SelectField
                    name={`profiling_duties.${idx}.duty_area`}
                    register={register}
                    label="Duty Area"
                    required
                    options={SEC013_DUTY_AREAS}
                    error={errors.profiling_duties?.[idx]?.duty_area}
                  />
                  <SelectField
                    name={`profiling_duties.${idx}.location`}
                    register={register}
                    label="Location"
                    required
                    options={SEC013_LOCATIONS}
                    error={errors.profiling_duties?.[idx]?.location}
                  />
                </FieldRow>
                <FieldRow>
                  <TextField
                    name={`profiling_duties.${idx}.time_from`}
                    type="time"
                    register={register}
                    label="Time From"
                    required
                    error={errors.profiling_duties?.[idx]?.time_from as never}
                  />
                  <TextField
                    name={`profiling_duties.${idx}.time_to`}
                    type="time"
                    register={register}
                    label="Time To"
                    required
                    hint={crossesMidnight ? "Time To is before Time From — OK if the shift crosses midnight." : undefined}
                    error={errors.profiling_duties?.[idx]?.time_to as never}
                  />
                </FieldRow>
                <TextField
                  name={`profiling_duties.${idx}.sector_flight`}
                  register={register}
                  label="Sector Flight"
                  required
                  error={errors.profiling_duties?.[idx]?.sector_flight}
                />
                <TextAreaField
                  name={`profiling_duties.${idx}.description`}
                  register={register}
                  label="Description / Daily Report"
                  required
                  error={errors.profiling_duties?.[idx]?.description}
                />
                <TextAreaField
                  name={`profiling_duties.${idx}.incident_remark`}
                  register={register}
                  label="Incident / Non-Compliance / Remark"
                  error={errors.profiling_duties?.[idx]?.incident_remark}
                />
              </EntryCard>
            );
          })}
        </div>

        <div className="card-inset p-4 space-y-3 text-center mt-3">
          <p className="font-semibold text-sm" style={{ color: "var(--ink2)" }}>Do you need to add another Profiling Report?</p>
          <div className="flex gap-2.5 justify-center">
            <button type="button" className="btn-secondary min-w-[100px]" onClick={handleAddAnother}>
              Yes
            </button>
            <button
              type="button"
              className="btn-primary min-w-[100px]"
              onClick={() =>
                document.getElementById("sec013-final-section")?.scrollIntoView({ behavior: "smooth" })
              }
            >
              No
            </button>
          </div>
        </div>
      </FormSection>

      <div id="sec013-final-section" className="card p-4 sm:p-5 space-y-4" style={{ borderColor: "var(--gold-fill)" }}>
        <h2 className="section-title">Final Remarks &amp; Certification</h2>
        <TextAreaField name="remark" register={register} label="Remark" error={errors.remark} />
        <RemarkQuickPhrases
          value={values.remark}
          onChange={(next) => setValue("remark", next, { shouldDirty: true })}
        />
        <TextAreaField
          name="corrective_action"
          register={register}
          label="Corrective Action / Follow-up / Recommendation"
          error={errors.corrective_action}
        />
        <CheckboxField
          name="acknowledgement"
          register={register}
          label={SEC013_CERTIFICATION_TEXT}
          error={errors.acknowledgement}
        />
      </div>

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit report ▸"}
      </button>
      <p className="text-center t-mono text-[9.5px]" style={{ color: "var(--faintest)" }}>
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
