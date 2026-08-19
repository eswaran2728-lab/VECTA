"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { STATIONS, REPORT_META } from "@/lib/avsec/reference-data";
import { offloadSchema } from "@/lib/avsec/schemas/offload";
import { submitOffload } from "@/lib/avsec/reports/actions";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/avsec/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  FieldRow,
  FormSection,
  FormStepIndicator,
  EntryCard,
} from "@/components/avsec/forms/fields";
import { SubmissionConfirmation } from "@/components/avsec/forms/SubmissionConfirmation";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/avsec/forms/AttachmentUpload";
import type { Profile } from "@/lib/avsec/types";

interface UIValues {
  station: string;
  team: string;
  staff_name: string;
  staff_id: string;
  flight_no: string;
  destination: string;
  aircraft_registration: string;
  flight_date: string;
  std: string;
  remark: string;
  verified_by_dse_name: string;
  verified_by_dse_id: string;
  items: {
    baggage_tag_no: string;
    reason: string;
    weight_kg: string;
  }[];
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("offload") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    staff_id: profile.staff_no,
    flight_no: "",
    destination: "",
    aircraft_registration: "",
    flight_date: "",
    std: "",
    remark: "",
    verified_by_dse_name: profile.role === "DSE" ? profile.name : "",
    verified_by_dse_id: profile.role === "DSE" ? profile.staff_no : "",
    items: [{ baggage_tag_no: "", reason: "", weight_kg: "" }],
  };
}

export function OffloadForm({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.offload;
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
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const values = watch();
  const { savedAt } = useDraftAutosave("offload", values);
  const { submit } = useOfflineSubmit("offload", submitOffload);

  const onSubmit = handleSubmit(async (v) => {
    const parsed = offloadSchema.safeParse(v);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(
      parsed.data,
      attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, blob: a.blob })),
    );
    if (outcome.kind === "submitted") {
      clearLocalDraft("offload");
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
      clearLocalDraft("offload");
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
        activeIndex={1}
      />

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={STATIONS} error={errors.station} />
          <TextField name="team" register={register} label="Team" required placeholder="e.g. Alpha" error={errors.team} />
        </FieldRow>
        <FieldRow>
          <TextField name="staff_name" register={register} label="Name" required error={errors.staff_name} />
          <TextField name="staff_id" register={register} label="Staff ID" required error={errors.staff_id} />
        </FieldRow>
      </FormSection>

      <FormSection title="Flight Details">
        <FieldRow>
          <TextField name="flight_no" register={register} label="Flight No" required placeholder="e.g. AK123" error={errors.flight_no} />
          <TextField name="destination" register={register} label="Destination" required error={errors.destination} />
        </FieldRow>
        <FieldRow>
          <TextField name="aircraft_registration" register={register} label="Aircraft Registration" required error={errors.aircraft_registration} />
          <TextField name="flight_date" type="date" register={register} label="Flight Date" required error={errors.flight_date as never} />
        </FieldRow>
        <TextField name="std" type="time" register={register} label="STD" error={errors.std as never} />
      </FormSection>

      <FormSection title="Offloaded Baggage" note="Add one entry per offloaded bag.">
        <div className="space-y-3">
          {fields.map((field, idx) => (
            <EntryCard
              key={field.id}
              label={`Bag ${idx + 1}`}
              onRemove={fields.length > 1 ? () => remove(idx) : undefined}
            >
              <FieldRow>
                <TextField
                  name={`items.${idx}.baggage_tag_no`}
                  register={register}
                  label="Baggage Tag No"
                  required
                  error={errors.items?.[idx]?.baggage_tag_no}
                />
                <TextField
                  name={`items.${idx}.weight_kg`}
                  register={register}
                  label="Weight (kg)"
                  type="number"
                  inputMode="decimal"
                  error={errors.items?.[idx]?.weight_kg}
                />
              </FieldRow>
              <TextField
                name={`items.${idx}.reason`}
                register={register}
                label="Reason"
                hint="e.g. weight restriction, no-show, security"
                error={errors.items?.[idx]?.reason}
              />
            </EntryCard>
          ))}
          {fields.length < 30 && (
            <button
              type="button"
              className="btn-add-entry"
              onClick={() => append({ baggage_tag_no: "", reason: "", weight_kg: "" })}
            >
              + Add Bag ({fields.length}/30)
            </button>
          )}
        </div>
      </FormSection>

      <FormSection title="Remark">
        <TextAreaField name="remark" register={register} label="Remark" rows={3} error={errors.remark} />
      </FormSection>

      {profile.role === "DSE" && (
        <FormSection title="DSE Verification" note="Only shown to DSE — confirms you have verified this offload count.">
          <FieldRow>
            <TextField name="verified_by_dse_name" register={register} label="Verified By" error={errors.verified_by_dse_name} />
            <TextField name="verified_by_dse_id" register={register} label="DSE Staff ID" error={errors.verified_by_dse_id} />
          </FieldRow>
        </FormSection>
      )}

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
