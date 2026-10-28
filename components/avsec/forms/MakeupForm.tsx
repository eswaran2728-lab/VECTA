"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { REPORT_META, SECURITY_DISCLAIMER } from "@/lib/avsec/reference-data";
import { makeupSchema, type MakeupFormValues } from "@/lib/avsec/schemas/makeup";
import { submitMakeup } from "@/lib/avsec/reports/actions";
import { saveDraft } from "@/lib/avsec/reports/drafts";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/avsec/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  FieldRow,
  FormSection,
  EntryCard,
} from "@/components/avsec/forms/fields";
import { SubmissionConfirmation } from "@/components/avsec/forms/SubmissionConfirmation";
import { SubmissionRecovery } from "@/components/avsec/forms/SubmissionRecovery";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/avsec/forms/AttachmentUpload";
import type { Profile } from "@/lib/avsec/types";

function buildDefaults(profile: Profile, serverDraft?: MakeupFormValues | null): MakeupFormValues {
  const draft = readLocalDraft<MakeupFormValues>(profile.id, "makeup") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    flight_number: "",
    duty_date: "",
    destination: "",
    first_baggage_time: "",
    last_baggage_tag_time: "",
    baggage_entries: [
      {
        container_pallet_trolley_no: "",
        seal_no: "",
        bay: "",
        destination: "",
      },
    ],
    ground_handling_personnel: "",
    remarks: "",
    discrepancies: [],
    officer_confirmation: false,
  };
}

export function MakeupForm({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: MakeupFormValues | null;
}) {
  const meta = REPORT_META.makeup;
  const [result, setResult] = useState<
    | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
    | { kind: "queued"; pendingAttachments?: number }
    | null
  >(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recovery, setRecovery] = useState<{ id: string; message: string; payload: unknown } | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    trigger,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<MakeupFormValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const {
    fields: baggageFields,
    append: appendBaggage,
    remove: removeBaggage,
  } = useFieldArray({ control, name: "baggage_entries" });

  const {
    fields: discFields,
    append: appendDisc,
    remove: removeDisc,
  } = useFieldArray({ control, name: "discrepancies" });

  const values = watch();
  const { savedAt } = useDraftAutosave(profile.id, "makeup", values);
  const { submit } = useOfflineSubmit("makeup", submitMakeup, profile.id);

  async function handleAddBaggage() {
    const lastIdx = baggageFields.length - 1;
    const valid = await trigger([
      `baggage_entries.${lastIdx}.container_pallet_trolley_no`,
      `baggage_entries.${lastIdx}.seal_no`,
      `baggage_entries.${lastIdx}.bay`,
      `baggage_entries.${lastIdx}.destination`,
    ] as never);
    if (!valid) return;
    appendBaggage({ container_pallet_trolley_no: "", seal_no: "", bay: "", destination: "" });
  }

  function handleAddDiscrepancy() {
    appendDisc({ baggage_tag_no: "", details: "" });
  }

  async function handleManualSaveDraft() {
    setDraftSaving(true);
    setDraftMessage(null);
    try {
      const res = await saveDraft("makeup", values);
      if (res.ok) {
        setDraftMessage("Draft saved to server successfully.");
      } else {
        setDraftMessage(`Failed to save draft: ${res.error || "Unknown error"}`);
      }
    } catch (err: unknown) {
      setDraftMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDraftSaving(false);
      setTimeout(() => setDraftMessage(null), 4000);
    }
  }

  const onSubmit = handleSubmit(async (v) => {
    const parsed = makeupSchema.safeParse(v);
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
      clearLocalDraft(profile.id, "makeup");
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
      clearLocalDraft(profile.id, "makeup");
      setResult({ kind: "queued", pendingAttachments: attachments.length });
      revokeAttachmentPreviews(attachments);
      setAttachments([]);
    } else if (outcome.id) {
      setRecovery({ id: outcome.id, message: outcome.message, payload: parsed.data });
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
    <form onSubmit={onSubmit} className="space-y-6">
      {recovery && (
        <SubmissionRecovery
          reportType="makeup"
          reportId={recovery.id}
          message={recovery.message}
          payload={recovery.payload}
          onRecovered={(r) => {
            setRecovery(null);
            clearLocalDraft(profile.id, "makeup");
            revokeAttachmentPreviews(attachments);
            setAttachments([]);
            setResult({ kind: "submitted", id: r.id, submittedAt: r.submittedAt, reportNo: r.reportNo });
          }}
          onGiveUp={() => setRecovery(null)}
        />
      )}

      {/* Draft autosave banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div>
          {savedAt ? (
            <span>Draft saved locally at {savedAt.toLocaleTimeString()}</span>
          ) : (
            <span>Unsaved draft</span>
          )}
          {draftMessage && <span className="ml-2 font-medium text-success">{draftMessage}</span>}
        </div>
        <button
          type="button"
          onClick={handleManualSaveDraft}
          disabled={draftSaving}
          className="btn-secondary text-xs px-3 py-1.5"
        >
          {draftSaving ? "Saving..." : "Save Draft"}
        </button>
      </div>

      {/* Section 1: Header */}
      <FormSection title="1. Header & Flight Details" note="Station, operational date, shift, flight and destination.">
        <FieldRow>
          <TextField
            name="station"
            register={register}
            label="Station"
            required
            error={errors.station}
          />
          <TextField
            name="team"
            register={register}
            label="Shift / Team"
            required
            error={errors.team}
          />
        </FieldRow>
        <FieldRow>
          <TextField
            name="duty_date"
            register={register}
            label="Operational Date"
            type="date"
            required
            error={errors.duty_date}
          />
          <TextField
            name="flight_number"
            register={register}
            label="Flight Number"
            placeholder="e.g. AK512 or D7220"
            required
            error={errors.flight_number}
          />
          <TextField
            name="destination"
            register={register}
            label="Destination"
            placeholder="e.g. KUL, PEN, SIN"
            required
            error={errors.destination}
          />
        </FieldRow>
      </FormSection>

      {/* Section 2: Timing */}
      <FormSection title="2. Timing" note="First and last baggage received times in Malaysia time (HH:MM).">
        <FieldRow>
          <TextField
            name="first_baggage_time"
            register={register}
            label="First Baggage Received Time"
            type="time"
            required
            error={errors.first_baggage_time}
          />
          <TextField
            name="last_baggage_tag_time"
            register={register}
            label="Last Baggage Tag Received Time"
            type="time"
            required
            error={errors.last_baggage_tag_time}
          />
        </FieldRow>
      </FormSection>

      {/* Section 3: Baggage Entries */}
      <FormSection
        title="3. Baggage Entries"
        note="Repeatable container, seal, bay, and destination records. At least 1 entry is required."
      >
        <div className="space-y-4">
          {baggageFields.map((field, index) => (
            <EntryCard
              key={field.id}
              label={`Baggage Container #${index + 1}`}
              onRemove={baggageFields.length > 1 ? () => removeBaggage(index) : undefined}
            >
              <FieldRow>
                <TextField
                  name={`baggage_entries.${index}.container_pallet_trolley_no` as const}
                  register={register as never}
                  label="Container / Pallet / Trolley No"
                  required
                  placeholder="e.g. AKE12345AK"
                  error={errors.baggage_entries?.[index]?.container_pallet_trolley_no}
                />
                <TextField
                  name={`baggage_entries.${index}.seal_no` as const}
                  register={register as never}
                  label="Seal Number"
                  required
                  placeholder="e.g. SL987654"
                  error={errors.baggage_entries?.[index]?.seal_no}
                />
              </FieldRow>
              <FieldRow>
                <TextField
                  name={`baggage_entries.${index}.bay` as const}
                  register={register as never}
                  label="Bay"
                  required
                  placeholder="e.g. B12 (Bay)"
                  error={errors.baggage_entries?.[index]?.bay}
                />
                <TextField
                  name={`baggage_entries.${index}.destination` as const}
                  register={register as never}
                  label="Destination"
                  required
                  placeholder="e.g. KUL"
                  error={errors.baggage_entries?.[index]?.destination}
                />
              </FieldRow>
            </EntryCard>
          ))}
          {errors.baggage_entries?.message && (
            <p className="text-sm font-medium text-destructive">{errors.baggage_entries.message}</p>
          )}
          <button
            type="button"
            onClick={handleAddBaggage}
            className="min-h-[44px] w-full sm:w-auto px-4 py-2 border-2 border-dashed border-border hover:border-primary rounded-lg text-sm font-medium text-foreground hover:text-primary transition-colors flex items-center justify-center gap-2"
          >
            <span>+ Add Another Baggage Entry</span>
          </button>
        </div>
      </FormSection>

      {/* Section 4: Baggage Discrepancies */}
      <FormSection
        title="4. Baggage Discrepancies (Optional)"
        note="Record tag numbers and discrepancy details if any discrepancies occurred. Leave empty if none."
      >
        <div className="space-y-4">
          {discFields.map((field, index) => (
            <EntryCard
              key={field.id}
              label={`Discrepancy #${index + 1}`}
              onRemove={() => removeDisc(index)}
            >
              <FieldRow>
                <TextField
                  name={`discrepancies.${index}.baggage_tag_no` as const}
                  register={register as never}
                  label="Baggage Tag Number"
                  placeholder="e.g. AK123456"
                  error={errors.discrepancies?.[index]?.baggage_tag_no}
                />
                <TextField
                  name={`discrepancies.${index}.details` as const}
                  register={register as never}
                  label="Discrepancy Details"
                  placeholder="e.g. Torn tag / unmanifested bag / damaged lock"
                  error={errors.discrepancies?.[index]?.details}
                />
              </FieldRow>
            </EntryCard>
          ))}
          <button
            type="button"
            onClick={handleAddDiscrepancy}
            className="btn-secondary min-h-[44px] w-full sm:w-auto px-4 py-2 flex items-center justify-center gap-2"
          >
            <span>+ Add Baggage Discrepancy</span>
          </button>
        </div>
      </FormSection>

      {/* Section 5: Additional Info & Confirmation */}
      <FormSection title="5. Additional Information & Officer Confirmation">
        <TextAreaField
          name="ground_handling_personnel"
          register={register}
          label="Ground-Handling Personnel Names & Staff Numbers"
          placeholder="e.g. Ali (GH102), Ahmad (GH108) or 'None / Not applicable'"
          error={errors.ground_handling_personnel}
        />
        <TextAreaField
          name="remarks"
          register={register}
          label="Remarks / Observations"
          placeholder="Any operational remarks, abnormal delays, or weather impact"
          error={errors.remarks}
        />

        <div className="pt-2">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              id="officer_confirmation"
              className="mt-1 h-5 w-5 rounded border-border text-primary focus:ring-primary"
              {...register("officer_confirmation")}
            />
            <span className="text-sm font-medium text-foreground">
              I confirm that all departure baggage information recorded above is accurate and verified prior to submission.
            </span>
          </label>
          {errors.officer_confirmation && (
            <p className="mt-1 text-xs text-destructive">{errors.officer_confirmation.message}</p>
          )}
        </div>
      </FormSection>

      {/* Section 6: Attachments */}
      <FormSection title="6. Attachments (Optional)" note="Upload baggage photos, seal images, or discrepancy evidence.">
        <AttachmentUpload value={attachments} onChange={setAttachments} />
      </FormSection>

      {/* Submission Actions */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t border-border">
        <button
          type="button"
          onClick={handleManualSaveDraft}
          disabled={draftSaving || isSubmitting}
          className="btn-secondary min-h-[44px] w-full sm:w-auto px-6 py-3"
        >
          {draftSaving ? "Saving Draft..." : "Save Draft"}
        </button>

        <button
          type="submit"
          disabled={isSubmitting}
          className="btn-primary min-h-[44px] w-full sm:w-auto px-8 py-3"
        >
          {isSubmitting ? "Submitting Report..." : "Submit Makeup Report"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground text-center">{SECURITY_DISCLAIMER}</p>
    </form>
  );
}
