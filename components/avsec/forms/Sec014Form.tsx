"use client";

import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { STATIONS, REPORT_META } from "@/lib/avsec/reference-data";
import { sec014Schema } from "@/lib/avsec/schemas/sec014";
import { submitSec014 } from "@/lib/avsec/reports/actions";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, readLocalDraftTime, clearLocalDraft } from "@/lib/avsec/offline/useDraftAutosave";
import { saveDraft, clearDraft } from "@/lib/avsec/reports/drafts";
import { decideDraftResume, shouldClearDraftsAfter, type TimedDraft } from "@/lib/avsec/reports/draft-resume";
import { combineDateTimeMY } from "@/lib/avsec/datetime";
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
} from "@/components/avsec/forms/fields";
import { SubmissionConfirmation } from "@/components/avsec/forms/SubmissionConfirmation";
import { SubmissionRecovery } from "@/components/avsec/forms/SubmissionRecovery";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/avsec/forms/AttachmentUpload";
import type { Profile } from "@/lib/avsec/types";

const SEC014_REMARK_QUICK_ADDS = [
  "Nil discrepancy",
  "Incident reported — refer email from DSE/duty officer",
  "Unattended baggage",
] as const;

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
    location: "Apron" | "Terminal" | "Premises" | "";
    time_from: string;
    time_to: string;
    description: string;
  }[];
  remark: string;
  acknowledgement: boolean;
}

function localDraftOf(profile: Profile): TimedDraft<UIValues> | null {
  const data = readLocalDraft<UIValues>(profile.id, "sec014");
  return data ? { data, savedAt: readLocalDraftTime(profile.id, "sec014") } : null;
}

function buildDefaults(profile: Profile, serverDraft?: TimedDraft<UIValues> | null): UIValues {
  const local = localDraftOf(profile);
  const resume = decideDraftResume(local, serverDraft ?? null);
  if (resume.kind === "server") return serverDraft!.data;
  if (resume.kind === "local" || resume.kind === "conflict") return local!.data;
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
  serverDraft?: TimedDraft<UIValues> | null;
}) {
  const meta = REPORT_META.sec014;
  const [result, setResult] = useState<
    | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
    | { kind: "queued"; pendingAttachments?: number }
    | null
  >(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recovery, setRecovery] = useState<{ id: string; message: string; payload: unknown } | null>(null);
  // Resolved once on the device: a draft on another device that differs from this device's draft is the user's choice, never silently overwritten.
  const [conflict, setConflict] = useState(() => {
    const r = decideDraftResume(localDraftOf(profile), serverDraft ?? null);
    return r.kind === "conflict" ? r : null;
  });
  const [draftStatus, setDraftStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);

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
  useDraftAutosave(profile.id, "sec014", values, true, { mirror: false });
  const { submit } = useOfflineSubmit("sec014", submitSec014, profile.id);

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
      clearLocalDraft(profile.id, "sec014");
      if (shouldClearDraftsAfter("submitted")) void clearDraft("sec014");
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
      // Queued is not confirmed: the draft stays until the server confirms the submission.
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
    <form onSubmit={onSubmit} className="space-y-5">
      {recovery && (
        <SubmissionRecovery
          reportType="sec014"
          reportId={recovery.id}
          message={recovery.message}
          payload={recovery.payload}
          onRecovered={(r) => {
            setRecovery(null);
            clearLocalDraft(profile.id, "sec014");
            void clearDraft("sec014");
            revokeAttachmentPreviews(attachments);
            setAttachments([]);
            setResult({ kind: "submitted", id: r.id, submittedAt: r.submittedAt, reportNo: r.reportNo });
          }}
          onGiveUp={() => setRecovery(null)}
        />
      )}
      {conflict && (
        <div className="card p-3 space-y-2 border border-warning/50" role="alert">
          <p className="font-mono text-xs font-bold text-foreground">Two different drafts of this report exist</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            This device: {conflict.localSavedAt ? new Date(conflict.localSavedAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" }) : "time unknown"} ·
            Saved to your account: {new Date(conflict.serverSavedAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}
            {conflict.newer === "unknown" ? "" : ` · the ${conflict.newer === "local" ? "device" : "account"} copy is newer`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary text-xs px-3 py-1" onClick={() => { reset(serverDraft!.data); setConflict(null); }}>Use the account draft</button>
            <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setConflict(null)}>Keep this device&apos;s draft</button>
          </div>
        </div>
      )}
      <FormStepIndicator
        code={meta.code}
        draftNote={draftStatus?.ok ? draftStatus.text : "KEPT ON THIS DEVICE · USE SAVE DRAFT TO RESUME ELSEWHERE"}
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

      <FormSection title="Patrolling" note="Add each patrol entry as it happens.">
        <div className="space-y-3">
          {fields.map((field, idx) => (
            <EntryCard key={field.id} label={`Entry ${idx + 1}`} onRemove={() => remove(idx)}>
              <FieldRow>
                <SelectField
                  name={`patrols.${idx}.location`}
                  register={register}
                  label="Location"
                  options={["Apron", "Terminal", "Premises"]}
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
          <button
            type="button"
            className="btn-add-entry"
            onClick={() =>
              append({ location: "", time_from: "", time_to: "", description: "" })
            }
          >
            + Add Patrol Entry
          </button>
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
          phrases={SEC014_REMARK_QUICK_ADDS}
        />
      </FormSection>

      <CheckboxField
        name="acknowledgement"
        register={register}
        label="By submitting the data in this e-form document, you acknowledge that; The information provided as true and correct."
        error={errors.acknowledgement}
      />

      <AttachmentUpload value={attachments} onChange={setAttachments} disabled={isSubmitting} />

      <button
        type="button"
        className="btn-secondary w-full"
        disabled={savingDraft || isSubmitting}
        onClick={async () => {
          setSavingDraft(true);
          setDraftStatus(null);
          try {
            const r = await saveDraft("sec014", watch());
            if (r.ok) setDraftStatus({ ok: true, text: `DRAFT SAVED TO YOUR ACCOUNT ${new Date(r.savedAt ?? Date.now()).toLocaleTimeString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}` });
            else setDraftStatus({ ok: false, text: r.error ?? "The draft could not be saved." });
          } catch {
            setDraftStatus({ ok: false, text: "The draft could not be saved. It is still kept on this device." });
          } finally {
            setSavingDraft(false);
          }
        }}
      >
        {savingDraft ? "Saving draft…" : "Save draft"}
      </button>
      {draftStatus && <p className={`text-xs font-mono ${draftStatus.ok ? "text-success" : "text-destructive"}`}>{draftStatus.ok ? draftStatus.text : `${draftStatus.text} Your entries are still kept on this device.`}</p>}
      <p className="font-mono text-[10px] text-muted-foreground">Save draft stores the whole form (not attached photos) so you can continue on another device.</p>
      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit report ▸"}
      </button>
      <p className="text-center font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
