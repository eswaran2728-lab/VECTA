"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { REPORT_META, SECURITY_DISCLAIMER } from "@/lib/avsec/reference-data";
import { breakupSchema, type BreakupFormValues } from "@/lib/avsec/schemas/breakup";
import { submitBreakup } from "@/lib/avsec/reports/actions";
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

function buildDefaults(profile: Profile, serverDraft?: BreakupFormValues | null): BreakupFormValues {
  const draft = readLocalDraft<BreakupFormValues>(profile.id, "breakup") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    flight_number: "",
    duty_date: "",
    origin: "",
    first_container_time: "",
    last_container_time: "",
    baggage_entries: [
      {
        container_pallet_trolley_no: "",
        baggage_tag_no: "",
        discrepancy_details: "",
      },
    ],
    ground_handling_personnel: "",
    pir_dpr_details: "",
    containers_inspected_clean: false,
  };
}

export function BreakupForm({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: BreakupFormValues | null;
}) {
  const meta = REPORT_META.breakup;
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
  } = useForm<BreakupFormValues>({ defaultValues: buildDefaults(profile, serverDraft) });

  const {
    fields: baggageFields,
    append: appendBaggage,
    remove: removeBaggage,
  } = useFieldArray({ control, name: "baggage_entries" });

  const values = watch();
  const { savedAt } = useDraftAutosave(profile.id, "breakup", values);
  const { submit } = useOfflineSubmit("breakup", submitBreakup, profile.id);

  async function handleAddBaggage() {
    const lastIdx = baggageFields.length - 1;
    const valid = await trigger([
      `baggage_entries.${lastIdx}.container_pallet_trolley_no`,
    ] as never);
    if (!valid) return;
    appendBaggage({ container_pallet_trolley_no: "", baggage_tag_no: "", discrepancy_details: "" });
  }

  async function handleManualSaveDraft() {
    setDraftSaving(true);
    setDraftMessage(null);
    try {
      const res = await saveDraft("breakup", values);
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
    const parsed = breakupSchema.safeParse(v);
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
      clearLocalDraft(profile.id, "breakup");
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
      clearLocalDraft(profile.id, "breakup");
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
          reportType="breakup"
          reportId={recovery.id}
          message={recovery.message}
          payload={recovery.payload}
          onRecovered={(r) => {
            setRecovery(null);
            clearLocalDraft(profile.id, "breakup");
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
      <FormSection title="1. Header & Flight Details" note="Station, operational date, shift, flight number, and origin.">
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
            name="origin"
            register={register}
            label="Origin"
            placeholder="e.g. SIN, BKK, CGK"
            required
            error={errors.origin}
          />
        </FieldRow>
      </FormSection>

      {/* Section 2: Timing */}
      <FormSection title="2. Timing" note="First and last arrival container received times in Malaysia time (HH:MM).">
        <FieldRow>
          <TextField
            name="first_container_time"
            register={register}
            label="First Container Received Time"
            type="time"
            required
            error={errors.first_container_time}
          />
          <TextField
            name="last_container_time"
            register={register}
            label="Last Container Received Time"
            type="time"
            required
            error={errors.last_container_time}
          />
        </FieldRow>
      </FormSection>

      {/* Section 3: Baggage Entries */}
      <FormSection
        title="3. Baggage Entries"
        note="Repeatable container, baggage tag, and discrepancy records. At least 1 entry is required."
      >
        <div className="space-y-4">
          {baggageFields.map((field, index) => (
            <EntryCard
              key={field.id}
              label={`Arrival Container #${index + 1}`}
              onRemove={baggageFields.length > 1 ? () => removeBaggage(index) : undefined}
            >
              <FieldRow>
                <TextField
                  name={`baggage_entries.${index}.container_pallet_trolley_no` as const}
                  register={register as never}
                  label="Container / Pallet / Trolley No"
                  required
                  placeholder="e.g. AKE56789AK"
                  error={errors.baggage_entries?.[index]?.container_pallet_trolley_no}
                />
                <TextField
                  name={`baggage_entries.${index}.baggage_tag_no` as const}
                  register={register as never}
                  label="Baggage Tag Number (where applicable)"
                  placeholder="e.g. AK654321 or leave blank"
                  error={errors.baggage_entries?.[index]?.baggage_tag_no}
                />
              </FieldRow>
              <TextField
                name={`baggage_entries.${index}.discrepancy_details` as const}
                register={register as never}
                label="Discrepancy Details"
                placeholder="e.g. Damaged container, unmanifested tag, or leave blank if none"
                error={errors.baggage_entries?.[index]?.discrepancy_details}
              />
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
            <span>+ Add Another Baggage Container</span>
          </button>
        </div>
      </FormSection>

      {/* Section 4: Ground Handling, PIR / DPR, & Inspection Confirmation */}
      <FormSection title="4. Ground Handling & Inspection Confirmation">
        <TextAreaField
          name="ground_handling_personnel"
          register={register}
          label="Ground-Handling Personnel Names & Staff Numbers"
          placeholder="e.g. Ismail (GH201), Faris (GH204) or 'None / Not applicable'"
          error={errors.ground_handling_personnel}
        />
        <TextAreaField
          name="pir_dpr_details"
          register={register}
          label="PIR / DPR Details (if any)"
          placeholder="Property Irregularity Report / Damage Report details, or 'None / Not applicable'"
          error={errors.pir_dpr_details}
        />

        <div className="pt-2">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              id="containers_inspected_clean"
              className="mt-1 h-5 w-5 rounded border-border text-primary focus:ring-primary"
              {...register("containers_inspected_clean")}
            />
            <span className="text-sm font-medium text-foreground">
              I confirm that all arrival baggage containers were inspected after offloading and nothing was left behind.
            </span>
          </label>
          {errors.containers_inspected_clean && (
            <p className="mt-1 text-xs text-destructive">{errors.containers_inspected_clean.message}</p>
          )}
        </div>
      </FormSection>

      {/* Section 5: Attachments */}
      <FormSection title="5. Attachments (Optional)" note="Upload container photos, offload verification, or PIR/DPR documents.">
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
          {isSubmitting ? "Submitting Report..." : "Submit Breakup Report"}
        </button>
      </div>

      <p className="text-xs text-muted-foreground text-center">{SECURITY_DISCLAIMER}</p>
    </form>
  );
}
