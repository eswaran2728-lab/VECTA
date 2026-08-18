"use client";

import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { STATIONS, REPORT_META } from "@/lib/reference-data";
import { sec014Schema, type Sec014FormValues } from "@/lib/schemas/sec014";
import { submitSec014 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import { combineDateTimeMY, splitDateTimeMY } from "@/lib/datetime";
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
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/forms/AttachmentUpload";
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
  patrols: {
    location: "Aircraft" | "Terminal" | "Premises" | "";
    time_from: string;
    time_to: string;
    description: string;
  }[];
  remark: string;
  acknowledgement: boolean;
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec014") ?? serverDraft;
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
    patrols: [],
    remark: "",
    acknowledgement: false,
  };
}

export function Sec014Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec014;
  const [result, setResult] = useState<
    | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
    | { kind: "queued"; pendingAttachments?: number }
    | null
  >(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const { fields, append, remove } = useFieldArray({ control, name: "patrols" });
  const values = watch();
  const { savedAt } = useDraftAutosave("sec014", values);
  const { submit } = useOfflineSubmit("sec014", submitSec014);

  const onSubmit = handleSubmit(async (v) => {
    const payload = {
      station: v.station,
      team: v.team,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      date_time_in: combineDateTimeMY(v.date_in, v.time_in),
      date_time_out: combineDateTimeMY(v.date_out, v.time_out),
      remark: v.remark,
      acknowledgement: v.acknowledgement,
      patrols: v.patrols.map((p) => ({
        location: p.location || null,
        time_from: p.time_from || null,
        time_to: p.time_to || null,
        description: p.description,
      })),
    };

    const parsed = sec014Schema.safeParse(payload);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        const path = issue.path.join(".") as keyof UIValues;
        setError(path as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(
      parsed.data,
      attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, blob: a.blob })),
    );
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec014");
      revokeAttachmentPreviews(attachments);
      setAttachments([]);
      setResult({
        kind: "submitted",
        id: outcome.id,
        submittedAt: outcome.submittedAt,
        reportNo: outcome.reportNo,
        attachmentErrors: outcome.attachmentErrors,
      });
    } else if (outcome.kind === "queued") {
      clearLocalDraft("sec014");
      setResult({ kind: "queued", pendingAttachments: attachments.length });
      revokeAttachmentPreviews(attachments);
      setAttachments([]);
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
        pendingAttachments={result.kind === "queued" ? result.pendingAttachments : undefined}
        attachmentErrors={result.kind === "submitted" ? result.attachmentErrors : undefined}
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
        activeIndex={values.acknowledgement ? 2 : 1}
      />

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField
            name="station"
            register={register}
            label="Station"
            required
            options={STATIONS}
            error={errors.station}
          />
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
          <TextField name="staff_name" register={register} label="Name" required error={errors.staff_name} />
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

      <FormSection title="Patrolling" note="Add each patrol entry as it happens — up to 15 per shift.">
        <div className="space-y-3">
          {fields.map((field, idx) => (
            <EntryCard key={field.id} label={`Entry ${idx + 1}`} onRemove={() => remove(idx)}>
              <FieldRow>
                <SelectField
                  name={`patrols.${idx}.location`}
                  register={register}
                  label="Location"
                  options={["Aircraft", "Terminal", "Premises"]}
                  error={errors.patrols?.[idx]?.location}
                />
                <div className="grid grid-cols-2 gap-2">
                  <TextField
                    name={`patrols.${idx}.time_from`}
                    type="time"
                    register={register}
                    label="Time From"
                    error={errors.patrols?.[idx]?.time_from as never}
                  />
                  <TextField
                    name={`patrols.${idx}.time_to`}
                    type="time"
                    register={register}
                    label="Time To"
                    error={errors.patrols?.[idx]?.time_to as never}
                  />
                </div>
              </FieldRow>
              <TextAreaField
                name={`patrols.${idx}.description`}
                register={register}
                label="Description / Report"
                required
                error={errors.patrols?.[idx]?.description}
              />
            </EntryCard>
          ))}
          {fields.length < 15 && (
            <button
              type="button"
              className="btn-add-entry"
              onClick={() =>
                append({ location: "", time_from: "", time_to: "", description: "" })
              }
            >
              + Add Patrol Entry ({fields.length}/15)
            </button>
          )}
        </div>
      </FormSection>

      <FormSection title="Remark">
        <TextAreaField
          name="remark"
          register={register}
          label="Issue(s) / Event(s) / Equipment(s):"
          required
          rows={4}
          error={errors.remark}
        />
        <RemarkQuickPhrases
          value={values.remark}
          onChange={(next) => setValue("remark", next, { shouldDirty: true })}
        />
      </FormSection>

      <CheckboxField
        name="acknowledgement"
        register={register}
        label="By submitting the data in this e-form document, you acknowledge that; The information provided as true and correct."
        error={errors.acknowledgement}
      />

      <AttachmentUpload value={attachments} onChange={setAttachments} disabled={isSubmitting} />

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit report ▸"}
      </button>
      <p className="text-center t-mono text-[9.5px]" style={{ color: "var(--faintest)" }}>
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
