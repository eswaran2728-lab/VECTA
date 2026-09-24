"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { SEC029_STATIONS, REPORT_META, SEC029_ITEMS } from "@/lib/avsec/reference-data";
import { sec029Schema } from "@/lib/avsec/schemas/sec029";
import { submitSec029 } from "@/lib/avsec/reports/actions";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/avsec/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  RadioGroupField,
  CheckboxField,
  FieldRow,
  FormSection,
  FormStepIndicator,
} from "@/components/avsec/forms/fields";
import { Sec029ChecklistItem } from "@/components/avsec/forms/Sec029ChecklistItem";
import { SubmissionConfirmation } from "@/components/avsec/forms/SubmissionConfirmation";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/avsec/forms/AttachmentUpload";
import { Camera } from "lucide-react";
import { cn } from "@/lib/avsec/utils";
import type { Profile } from "@/lib/avsec/types";
import type { EligibleOfficer } from "@/lib/avsec/reports/queries";

interface UIValues {
  station: string;
  team: string;
  supervising_officer_profile_id: string;
  supervising_officer_name: string;
  supervising_officer_id: string;
  staff_name: string;
  staff_id: string;
  assisted_by_name: string;
  assisted_by_id: string;

  aircraft_type: "A320" | "A321" | "A330" | "Others";
  aircraft_type_other: string;
  flight_no: string;
  flight_destination: string;
  aircraft_registration: string;
  std: string;
  parking_bay: string;
  time_commence: string;
  time_completed: string;

  items: {
    item_code: string;
    checked: "YES" | "NO" | "NA";
    remark_type: "nil" | "other" | "na";
    remark_text: string;
  }[];

  pic_informed: "YES" | "NO";
  declaration: string;
  d_remark: string;
  acknowledgement: boolean;
}

const DECLARATION_CLEAN =
  "I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.";
const DECLARATION_DISCREPANCY =
  "DISCREPANCIES FOUND AND DUTY SECURITY EXECUTIVE / DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW).";

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>(profile.id, "sec029") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    supervising_officer_profile_id: "",
    supervising_officer_name: "",
    supervising_officer_id: "",
    staff_name: profile.name,
    staff_id: profile.staff_no,
    assisted_by_name: "",
    assisted_by_id: "",
    aircraft_type: "A320",
    aircraft_type_other: "",
    flight_no: "",
    flight_destination: "",
    aircraft_registration: "",
    std: "",
    parking_bay: "",
    time_commence: "",
    time_completed: "",
    items: SEC029_ITEMS.map((item) => ({
      item_code: item.code,
      checked: "YES",
      remark_type: "nil",
      remark_text: "",
    })),
    pic_informed: "YES",
    declaration: DECLARATION_CLEAN,
    d_remark: "",
    acknowledgement: false,
  };
}

// "A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)" and "CARGO HOLD (EXTERNAL)" are heading-
// only — neither has an independent CHECKED/REMARK control of its own; only the items
// filed under them (via SEC029_ITEMS' `section`) do.
const SECTION_ORDER = [
  "A. GALLEY",
  "B. LAVATORY",
  "C. SEAT",
  "OTHER ACCESSIBLE COMPARTMENTS",
  "COCKPIT AREA",
  "4. U.S FLIGHTS ONLY",
  "A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)",
  "CARGO HOLD (EXTERNAL)",
];

export function Sec029Form({
  profile,
  serverDraft,
  eligibleOfficers,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
  /** SO/DSE profiles on the signed-in ASO's own team/station/ops_group — see
   *  getEligibleSupervisingOfficers. */
  eligibleOfficers: EligibleOfficer[];
}) {
  const meta = REPORT_META.sec029;
  const [result, setResult] = useState<
    | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
    | { kind: "queued"; pendingAttachments?: number }
    | null
  >(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [photoRequiredError, setPhotoRequiredError] = useState(false);

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
  const { savedAt } = useDraftAutosave(profile.id, "sec029", values);
  const { submit } = useOfflineSubmit("sec029", submitSec029, profile.id);

  const discrepanciesFound = values.declaration === DECLARATION_DISCREPANCY;
  const hasPhoto = attachments.some((a) => a.mimeType.startsWith("image/"));

  const officerReg = register("supervising_officer_profile_id");

  const onSubmit = handleSubmit(async (v) => {
    setPhotoRequiredError(false);

    // Photo Evidence Required (spec item 6): distinct from the PIC confirmation — at
    // least one photo is mandatory when discrepancies are declared. A PDF alone
    // doesn't satisfy it. Enforced here since attachments upload separately from the
    // report row (see useOfflineSubmit).
    if (discrepanciesFound && !hasPhoto) {
      setPhotoRequiredError(true);
      document.getElementById("sec029-attachments")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const parsed = sec029Schema.safeParse(v);
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
      clearLocalDraft(profile.id, "sec029");
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
      clearLocalDraft(profile.id, "sec029");
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
          setPhotoRequiredError(false);
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
        steps={["STAFF", "CHECKLIST", "SUBMIT"]}
        activeIndex={values.acknowledgement ? 2 : 1}
      />

      {/* 1. Staff Details */}
      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={SEC029_STATIONS} error={errors.station} />
          <TextField name="team" register={register} label="Team" required placeholder="e.g. Alpha" error={errors.team} />
        </FieldRow>

        <FieldRow>
          <div>
            <label className="field-label" htmlFor="supervising_officer_profile_id">
              Supervising Officer Name <span className="text-red-400">*</span>
            </label>
            <select
              id="supervising_officer_profile_id"
              className="input-base"
              defaultValue=""
              {...officerReg}
              onChange={(e) => {
                officerReg.onChange(e);
                const officer = eligibleOfficers.find((o) => o.id === e.target.value);
                setValue("supervising_officer_name", officer?.name ?? "", { shouldDirty: true, shouldValidate: true });
                setValue("supervising_officer_id", officer?.staff_no ?? "", { shouldDirty: true, shouldValidate: true });
              }}
            >
              <option value="" disabled className="bg-card text-muted-foreground">
                {eligibleOfficers.length === 0 ? "No SO/DSE found on your team" : "Select…"}
              </option>
              {eligibleOfficers.map((o) => (
                <option key={o.id} value={o.id} className="bg-card text-foreground">
                  {o.name} ({o.staff_no})
                </option>
              ))}
            </select>
            <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">
              Only SO/DSE on your own team are listed.
            </p>
            {errors.supervising_officer_profile_id && (
              <p className="text-xs text-red-400 font-mono mt-1.5">{errors.supervising_officer_profile_id.message}</p>
            )}
          </div>
          <TextField
            name="supervising_officer_id"
            register={register}
            label="Supervising Officer ID Number"
            required
            error={errors.supervising_officer_id}
            className="pointer-events-none opacity-70"
          />
        </FieldRow>

        <FieldRow>
          <TextField name="staff_name" register={register} label="Staff Name" required error={errors.staff_name} />
          <TextField name="staff_id" register={register} label="Staff ID" required error={errors.staff_id} />
        </FieldRow>
        <FieldRow>
          <TextField name="assisted_by_name" register={register} label="Assisted By (Name)" required error={errors.assisted_by_name} />
          <TextField name="assisted_by_id" register={register} label="Assisted By (ID Number)" required error={errors.assisted_by_id} />
        </FieldRow>
      </FormSection>

      {/* 2. Aircraft Details */}
      <FormSection title="Aircraft Details">
        <SelectField
          name="aircraft_type"
          register={register}
          label="Aircraft Type"
          required
          options={["A320", "A321", "A330", "Others"]}
          error={errors.aircraft_type as never}
        />
        {values.aircraft_type === "Others" && (
          <TextField
            name="aircraft_type_other"
            register={register}
            label="Specify aircraft type"
            required
            error={errors.aircraft_type_other}
          />
        )}
        <FieldRow>
          <TextField name="flight_no" register={register} label="Flight No" required error={errors.flight_no} />
          <TextField name="flight_destination" register={register} label="Flight Destination" error={errors.flight_destination} />
        </FieldRow>
        <FieldRow>
          <TextField name="aircraft_registration" register={register} label="Aircraft Registration" required error={errors.aircraft_registration} />
          <TextField name="std" type="time" register={register} label="Standard Time Departure (STD)" required error={errors.std as never} />
        </FieldRow>
        <FieldRow>
          <TextField name="parking_bay" register={register} label="Parking Bay" required error={errors.parking_bay} />
          <TextField name="time_commence" type="time" register={register} label="Time Commence" required error={errors.time_commence as never} />
        </FieldRow>
        <TextField name="time_completed" type="time" register={register} label="Time Completed" required error={errors.time_completed as never} />
      </FormSection>

      {/* 3. Internal Area */}
      <FormSection
        title="Internal Area"
        note="A pre-departure security search list shall consist of an examination of the following areas, when they are accessible without the use of tools, keys, stairs or other aids and without breaking seals"
      >
        {SECTION_ORDER.slice(0, 6).map((section) => {
          const itemsInSection = SEC029_ITEMS.map((item, idx) => ({ ...item, idx })).filter(
            (i) => i.section === section,
          );
          if (itemsInSection.length === 0) return null;
          return (
            <div key={section} className="space-y-3">
              <h3 className="font-bold text-xs font-mono uppercase tracking-wider text-foreground">
                {section}
                {section === "COCKPIT AREA" && (
                  <span className="block text-[11px] font-mono font-normal mt-0.5 text-amber-400">
                    NOTE: DO NOT TOUCH THE INSTRUMENT PANEL
                  </span>
                )}
              </h3>
              {itemsInSection.map((item) => (
                <Sec029ChecklistItem
                  key={item.code}
                  index={item.idx}
                  label={item.label}
                  allowNotApplicable={item.allowNotApplicable}
                  register={register}
                  watch={watch}
                  setValue={setValue}
                  errors={errors}
                />
              ))}
            </div>
          );
        })}
      </FormSection>

      {/* 4. External Area */}
      <FormSection title="External Area">
        {SECTION_ORDER.slice(6).map((section) => {
          const itemsInSection = SEC029_ITEMS.map((item, idx) => ({ ...item, idx })).filter(
            (i) => i.section === section,
          );
          if (itemsInSection.length === 0) return null;
          return (
            <div key={section} className="space-y-3">
              <h3 className="font-bold text-xs font-mono uppercase tracking-wider text-foreground">{section}</h3>
              {itemsInSection.map((item) => (
                <Sec029ChecklistItem
                  key={item.code}
                  index={item.idx}
                  label={item.label}
                  allowNotApplicable={item.allowNotApplicable}
                  register={register}
                  watch={watch}
                  setValue={setValue}
                  errors={errors}
                />
              ))}
            </div>
          );
        })}
      </FormSection>

      {/* 5. Final PIC confirmation */}
      <FormSection title="Final">
        <RadioGroupField
          name="pic_informed"
          register={register}
          label="Informed PIC that aircraft security check has been completed"
          required
          options={["YES", "NO"]}
          error={errors.pic_informed as never}
        />

        {/* 6. Declaration and conditional discrepancy details */}
        <div>
          <label className="field-label">
            Declaration <span className="text-red-400">*</span>
          </label>
          <div className="space-y-2">
            {[DECLARATION_CLEAN, DECLARATION_DISCREPANCY].map((opt) => (
              <label
                key={opt}
                className="flex items-start gap-3 border border-border/80 bg-surface/60 rounded-lg p-3 cursor-pointer transition-all
                  has-[:checked]:border-primary has-[:checked]:bg-primary/5 hover:border-border"
              >
                <input type="radio" value={opt} className="mt-1 text-primary focus:ring-primary" {...register("declaration")} />
                <span className="text-xs text-foreground leading-relaxed">{opt}</span>
              </label>
            ))}
          </div>
          {errors.declaration && <p className="text-xs text-red-400 font-mono mt-1">{errors.declaration.message}</p>}
        </div>

        {discrepanciesFound && (
          <>
            <TextAreaField
              name="d_remark"
              register={register}
              label="(D) Remark / Detection"
              required
              error={errors.d_remark}
            />
            <div
              id="sec029-photo-notice"
              className={cn(
                "card-inset p-3 rounded-lg border flex items-start gap-2.5",
                hasPhoto ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/50 bg-amber-500/10"
              )}
            >
              <Camera className={cn("h-4 w-4 mt-0.5 shrink-0", hasPhoto ? "text-emerald-400" : "text-amber-400")} />
              <p className="text-xs font-semibold text-foreground">
                Photo Evidence Required — {hasPhoto
                  ? "at least one photo is attached."
                  : "at least one photo is required before this report can be submitted. A PDF alone does not satisfy this requirement. This is separate from the PIC confirmation above."}
              </p>
            </div>
          </>
        )}

        {/* 7. Acknowledgment */}
        <CheckboxField
          name="acknowledgement"
          register={register}
          label="The information provided as true and correct."
          error={errors.acknowledgement}
        />
      </FormSection>

      {/* 8. Attachments */}
      <div id="sec029-attachments">
        <AttachmentUpload value={attachments} onChange={setAttachments} disabled={isSubmitting} />
        {photoRequiredError && (
          <p className="text-xs text-red-400 font-mono mt-2">
            ⚠ Add at least one photo before submitting — discrepancies were declared and a PDF alone isn&apos;t enough.
          </p>
        )}
      </div>

      {/* 9. Submit report and immutability notice */}
      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit report ▸"}
      </button>
      <p className="text-center font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
