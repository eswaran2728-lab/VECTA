"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { STATIONS, REPORT_META, SEC029_ITEMS } from "@/lib/reference-data";
import { sec029Schema } from "@/lib/schemas/sec029";
import { submitSec029 } from "@/lib/reports/actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  RadioGroupField,
  CheckboxField,
  FieldRow,
  FormSection,
  FormStepIndicator,
} from "@/components/forms/fields";
import { Sec029ChecklistItem } from "@/components/forms/Sec029ChecklistItem";
import { SubmissionConfirmation } from "@/components/forms/SubmissionConfirmation";
import type { Profile } from "@/lib/types";

interface UIValues {
  station: string;
  team: string;
  supervising_officer_name: string;
  supervising_officer_id: string;
  staff_name: string;
  staff_id: string;
  assisted_by_name: string;
  assisted_by_id: string;

  aircraft_type: "A320" | "A321" | "A330";
  flight_no: string;
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
  "I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.";
const DECLARATION_DISCREPANCY =
  "DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)";

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec029") ?? serverDraft;
  if (draft) return draft;
  return {
    station: profile.station ?? "",
    team: profile.team ?? "",
    supervising_officer_name: "",
    supervising_officer_id: "",
    staff_name: profile.name,
    staff_id: profile.staff_no,
    assisted_by_name: "",
    assisted_by_id: "",
    aircraft_type: "A320",
    flight_no: "",
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

const SECTION_ORDER = [
  "A. GALLEY",
  "B. LAVATORY",
  "C. SEAT",
  "OTHER ACCESSIBLE COMPARTMENTS",
  "COCKPIT AREA",
  "4. U.S FLIGHTS ONLY",
  "A. AIRCRAFT (EXTERNAL)",
  "B. CARGO HOLD (EXTERNAL)",
];

export function Sec029Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec029;
  const [result, setResult] = useState<
    { kind: "submitted"; id: string; submittedAt?: string } | { kind: "queued" } | null
  >(null);

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
  const { savedAt } = useDraftAutosave("sec029", values);
  const { submit } = useOfflineSubmit("sec029", submitSec029);

  const onSubmit = handleSubmit(async (v) => {
    const parsed = sec029Schema.safeParse(v);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      return;
    }

    const outcome = await submit(parsed.data);
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec029");
      setResult({ kind: "submitted", id: outcome.id, submittedAt: outcome.submittedAt });
    } else if (outcome.kind === "queued") {
      clearLocalDraft("sec029");
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
      <FormStepIndicator
        code={meta.code}
        draftNote={savedAt ? `DRAFT SAVED ${savedAt.toLocaleTimeString()}` : "AUTOSAVING…"}
        steps={["STAFF", "CHECKLIST", "SUBMIT"]}
        activeIndex={values.acknowledgement ? 2 : 1}
      />

      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={STATIONS} error={errors.station} />
          <TextField name="team" register={register} label="Team" required placeholder="e.g. Alpha" error={errors.team} />
        </FieldRow>
        <FieldRow>
          <TextField name="supervising_officer_name" register={register} label="Supervising Officer Name" required error={errors.supervising_officer_name} />
          <TextField name="supervising_officer_id" register={register} label="Supervising Officer ID Number" required error={errors.supervising_officer_id} />
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

      <FormSection title="Aircraft Details">
        <RadioGroupField name="aircraft_type" register={register} label="Aircraft Type" required columns={3} options={["A320", "A321", "A330"]} error={errors.aircraft_type as never} />
        <FieldRow>
          <TextField name="flight_no" register={register} label="Flight No" required error={errors.flight_no} />
          <TextField name="aircraft_registration" register={register} label="Aircraft Registration" required error={errors.aircraft_registration} />
        </FieldRow>
        <FieldRow>
          <TextField name="std" type="time" register={register} label="Standard Time Departure (STD)" required error={errors.std as never} />
          <TextField name="parking_bay" register={register} label="Parking Bay" required error={errors.parking_bay} />
        </FieldRow>
        <FieldRow>
          <TextField name="time_commence" type="time" register={register} label="Time Commence" required error={errors.time_commence as never} />
          <TextField name="time_completed" type="time" register={register} label="Time Completed" required error={errors.time_completed as never} />
        </FieldRow>
      </FormSection>

      <FormSection
        title="Internal Area"
        note="COMPARTMENTS THAT DO NOT REQUIRE SPECIAL TOOL TO OPEN MUST BE CHECKED & SEARCHED"
      >
        {SECTION_ORDER.slice(0, 6).map((section) => {
          const itemsInSection = SEC029_ITEMS.map((item, idx) => ({ ...item, idx })).filter(
            (i) => i.section === section,
          );
          if (itemsInSection.length === 0) return null;
          return (
            <div key={section} className="space-y-3">
              <h3 className="font-semibold text-sm" style={{ color: "var(--ink3)" }}>
                {section}
                {section === "COCKPIT AREA" && (
                  <span className="block text-xs font-normal mt-0.5" style={{ color: "var(--gold)" }}>
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

      <FormSection title="External Area">
        {SECTION_ORDER.slice(6).map((section) => {
          const itemsInSection = SEC029_ITEMS.map((item, idx) => ({ ...item, idx })).filter(
            (i) => i.section === section,
          );
          if (itemsInSection.length === 0) return null;
          return (
            <div key={section} className="space-y-3">
              <h3 className="font-semibold text-sm text-slate-600 dark:text-slate-300">{section}</h3>
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

      <FormSection title="Final">
        <RadioGroupField
          name="pic_informed"
          register={register}
          label="6. Information to Pilot in Command (PIC)"
          required
          options={["YES", "NO"]}
          error={errors.pic_informed as never}
        />

        <div>
          <label className="field-label">
            Declaration <span style={{ color: "var(--red)" }}>*</span>
          </label>
          <div className="space-y-2">
            {[DECLARATION_CLEAN, DECLARATION_DISCREPANCY].map((opt) => (
              <label
                key={opt}
                className="flex items-start gap-3 border border-[var(--line3)] p-3 cursor-pointer
                  has-[:checked]:border-[var(--gold-fill)] has-[:checked]:bg-[var(--gold-soft)]"
              >
                <input type="radio" value={opt} className="mt-1 accent-[var(--gold)]" {...register("declaration")} />
                <span className="text-sm" style={{ color: "var(--ink2)" }}>{opt}</span>
              </label>
            ))}
          </div>
          {errors.declaration && <p className="field-error">{errors.declaration.message}</p>}
        </div>

        {values.declaration === DECLARATION_DISCREPANCY && (
          <TextAreaField
            name="d_remark"
            register={register}
            label="(D) Remark / Detection"
            required
            error={errors.d_remark}
          />
        )}

        <CheckboxField
          name="acknowledgement"
          register={register}
          label="The information provided as true and correct."
          error={errors.acknowledgement}
        />
      </FormSection>

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? "Submitting…" : "Submit report ▸"}
      </button>
      <p className="text-center t-mono text-[9.5px]" style={{ color: "var(--faintest)" }}>
        SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
      </p>
    </form>
  );
}
