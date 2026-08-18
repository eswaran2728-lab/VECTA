"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { REPORT_META, SECURITY_DISCLAIMER } from "@/lib/reference-data";
import { sec033Schema } from "@/lib/schemas/sec033";
import { submitSec033 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import { TextField, TextAreaField, FieldRow, FormSection, FormStepIndicator, EntryCard } from "@/components/forms/fields";
import { SubmissionConfirmation } from "@/components/forms/SubmissionConfirmation";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/forms/AttachmentUpload";
import type { Profile } from "@/lib/types";

interface UIValues {
  station: string;
  team: string;
  staff_name: string;
  staff_id: string;
  report_date: string;
  report_time: string;
  hold_checks: {
    parking_bay_no: string;
    aircraft_registration_no: string;
    remarks: string;
  }[];
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec033") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    staff_id: profile.staff_no,
    report_date: "",
    report_time: "",
    hold_checks: [{ parking_bay_no: "", aircraft_registration_no: "", remarks: "" }],
  };
}

export function Sec033Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec033;
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
    trigger,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UIValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const { fields, append, remove } = useFieldArray({ control, name: "hold_checks" });
  const values = watch();
  const { savedAt } = useDraftAutosave("sec033", values);
  const { submit } = useOfflineSubmit("sec033", submitSec033);

  const lastIndex = fields.length - 1;

  async function handleAddAnother() {
    const valid = await trigger(
      [
        `hold_checks.${lastIndex}.parking_bay_no`,
        `hold_checks.${lastIndex}.aircraft_registration_no`,
      ] as never,
    );
    if (!valid) return;
    append({ parking_bay_no: "", aircraft_registration_no: "", remarks: "" });
  }

  const onSubmit = handleSubmit(async (v) => {
    const parsed = sec033Schema.safeParse(v);
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
      clearLocalDraft("sec033");
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
      clearLocalDraft("sec033");
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
        steps={["STAFF", "HOLD CHECKS", "SUBMIT"]}
        activeIndex={1}
      />

      <p className="disclaimer-band">{SECURITY_DISCLAIMER}</p>

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <TextField name="station" register={register} label="Station" required error={errors.station} />
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
          <TextField
            name="report_date"
            type="date"
            register={register}
            label="Date"
            required
            error={errors.report_date as never}
          />
          <TextField
            name="report_time"
            type="time"
            register={register}
            label="Time"
            required
            error={errors.report_time as never}
          />
        </FieldRow>
      </FormSection>

      <FormSection
        title="Hold Check Details"
        note="Ensure the cargo compartment is completely clear of any left-behind, unattended, prohibited or suspicious items/objects."
      >
        <div className="space-y-3">
          {fields.map((field, idx) => (
            <EntryCard
              key={field.id}
              label={`Hold Check ${idx + 1}`}
              onRemove={fields.length > 1 ? () => remove(idx) : undefined}
            >
              <FieldRow>
                <TextField
                  name={`hold_checks.${idx}.parking_bay_no`}
                  register={register}
                  label="Parking Bay No"
                  required
                  error={errors.hold_checks?.[idx]?.parking_bay_no}
                />
                <TextField
                  name={`hold_checks.${idx}.aircraft_registration_no`}
                  register={register}
                  label="A/C Registration No"
                  required
                  error={errors.hold_checks?.[idx]?.aircraft_registration_no}
                />
              </FieldRow>
              <TextAreaField
                name={`hold_checks.${idx}.remarks`}
                register={register}
                label="Discrepancies / Incident / Non-Compliance / Remark / Issue"
                error={errors.hold_checks?.[idx]?.remarks}
              />
            </EntryCard>
          ))}
        </div>

        <AttachmentUpload value={attachments} onChange={setAttachments} disabled={isSubmitting} />

        <div className="card-inset p-4 space-y-3 text-center mt-3">
          <p className="font-semibold text-sm" style={{ color: "var(--ink2)" }}>
            Do you need to add another Report?
          </p>
          <div className="flex gap-2.5 justify-center">
            <button type="button" className="btn-secondary min-w-[100px]" onClick={handleAddAnother}>
              Yes
            </button>
            <button type="submit" className="btn-primary min-w-[140px]" disabled={isSubmitting}>
              {isSubmitting ? "Submitting…" : "No, Submitted"}
            </button>
          </div>
        </div>
      </FormSection>

      <p className="text-center t-mono text-[9.5px]" style={{ color: "var(--faintest)" }}>
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
