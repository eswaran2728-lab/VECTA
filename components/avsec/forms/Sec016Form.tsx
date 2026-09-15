"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { STATIONS, REPORT_META } from "@/lib/avsec/reference-data";
import { sec016Schema } from "@/lib/avsec/schemas/sec016";
import { submitSec016 } from "@/lib/avsec/reports/actions";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { useDraftAutosave, readLocalDraft, clearLocalDraft } from "@/lib/avsec/offline/useDraftAutosave";
import {
  TextField,
  TextAreaField,
  SelectField,
  RadioGroupField,
  FieldRow,
  FormSection,
  FormStepIndicator,
} from "@/components/avsec/forms/fields";
import { SubmissionConfirmation } from "@/components/avsec/forms/SubmissionConfirmation";
import { AttachmentUpload, revokeAttachmentPreviews, type PendingAttachment } from "@/components/avsec/forms/AttachmentUpload";
import { SmartInputSec016 } from "@/components/avsec/forms/SmartInputSec016";
import { PlaneLanding, PlaneTakeoff, Star, Camera } from "lucide-react";
import { cn } from "@/lib/avsec/utils";
import type { Profile } from "@/lib/avsec/types";

interface UIValues {
  flight_type: "arrival" | "departure";
  aircraft_search_completed: boolean;
  station: string;
  team: string;
  staff_name: string;
  staff_no: string;
  duty_date: string;
  duty_hour: string;

  flight: string;
  origin_arr_dep: string;
  assisted_by: string;
  aircraft_type: "A 320" | "A 321" | "A 330" | "Other";
  aircraft_type_other: string;
  reg_no: string;
  sta_std: string;
  ata_atd: string;
  bay_no: string;
  reason_for_delay: string;
  do_infmd: "YES" | "NO";
  inbound_baggage: string;
  outbound_baggage: string;
  inbound_cargo: string;
  outbound_cargo: string;
  inbound_co_mail: string;
  outbound_co_mail: string;
  shift_leader: string;
  ramp_agents_baggage: string;
  ramp_agents_cargo: string;
  cargo_hold_checked: "YES" | "NO";
  staff_frisked: "YES" | "NO";
  cabin_check?: "YES" | "NO";
  discrepancies: string;

  offload_baggage_tag_no: string;
  offload_remark: string;
}

function buildDefaults(profile: Profile, serverDraft?: UIValues | null): UIValues {
  const draft = readLocalDraft<UIValues>("sec016") ?? serverDraft;
  if (draft) return draft;
  return {
    flight_type: "arrival",
    aircraft_search_completed: false,
    station: profile.station ?? "",
    team: profile.team ?? "",
    staff_name: profile.name,
    staff_no: profile.staff_no,
    duty_date: "",
    duty_hour: "",
    flight: "",
    origin_arr_dep: "",
    assisted_by: "",
    aircraft_type: "A 320",
    aircraft_type_other: "",
    reg_no: "",
    sta_std: "",
    ata_atd: "",
    bay_no: "",
    reason_for_delay: "",
    do_infmd: "NO",
    inbound_baggage: "",
    outbound_baggage: "",
    inbound_cargo: "",
    outbound_cargo: "",
    inbound_co_mail: "",
    outbound_co_mail: "",
    shift_leader: "",
    ramp_agents_baggage: "",
    ramp_agents_cargo: "",
    cargo_hold_checked: "NO",
    staff_frisked: "NO",
    cabin_check: undefined,
    discrepancies: "",
    offload_baggage_tag_no: "",
    offload_remark: "",
  };
}

/** Which guided-flow step (0-indexed) each field lives in, so a validation
 * error on a hidden step jumps the user there instead of failing silently. */
const FIELD_STEP: Record<string, number> = {
  station: 0,
  team: 0,
  staff_name: 0,
  staff_no: 0,
  duty_date: 0,
  duty_hour: 0,
  flight: 1,
  origin_arr_dep: 1,
  assisted_by: 1,
  aircraft_type: 1,
  aircraft_type_other: 1,
  reg_no: 1,
  sta_std: 1,
  ata_atd: 1,
  bay_no: 1,
  reason_for_delay: 1,
  do_infmd: 1,
  inbound_baggage: 1,
  outbound_baggage: 1,
  inbound_cargo: 1,
  outbound_cargo: 1,
  inbound_co_mail: 1,
  outbound_co_mail: 1,
  shift_leader: 1,
  ramp_agents_baggage: 1,
  ramp_agents_cargo: 1,
  cargo_hold_checked: 2,
  staff_frisked: 2,
  cabin_check: 2,
  discrepancies: 2,
  offload_baggage_tag_no: 2,
  offload_remark: 2,
};

const DISCREPANCY_QUICK_ADDS = ["Nil discrepancy", "Incident reported", "Baggage discrepancy"] as const;
const OFFLOAD_QUICK_ADDS = [
  "Passenger no show at the departure gate",
  "Passenger customs / immigration / quarantine (CIQ)",
  "Offload by airline",
  "Volunteer offload",
  "Offload by AVSEC",
] as const;

/** Clickable star that toggles the "Name ID (hold/tarmac)" entry-format guidance
 *  beside a Ramp agent details label. */
function FormatGuidanceStar() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-primary transition-colors cursor-pointer"
        aria-label="Show entry format guidance"
        title="Show entry format guidance"
      >
        <Star className={cn("h-3.5 w-3.5", open && "fill-primary text-primary")} />
      </button>
      {open && (
        <div className="absolute left-0 top-5 z-10 w-56 rounded-lg border border-border bg-card p-2.5 shadow-lg">
          <p className="font-mono text-[10px] leading-relaxed text-foreground whitespace-pre-line">
            Name ID (hold){"\n"}Name ID (tarmac)
          </p>
        </div>
      )}
    </span>
  );
}

function RampAgentsField({
  name,
  label,
  register,
  error,
}: {
  name: "ramp_agents_baggage" | "ramp_agents_cargo";
  label: string;
  register: ReturnType<typeof useForm<UIValues>>["register"];
  error?: { message?: string };
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <label className="field-label" htmlFor={name}>
          {label} <span className="text-red-400">*</span>
        </label>
        <FormatGuidanceStar />
      </div>
      <textarea
        id={name}
        rows={4}
        className="input-base font-mono text-xs leading-relaxed"
        placeholder={"One agent per line, e.g.\nJohn Doe A1234 (hold)\nJane Roe A5678 (tarmac)"}
        {...register(name)}
      />
      {error?.message && <p className="text-xs text-red-400 font-mono mt-1.5">{error.message}</p>}
    </div>
  );
}

export function Sec016Form({
  profile,
  serverDraft,
}: {
  profile: Profile;
  serverDraft?: UIValues | null;
}) {
  const meta = REPORT_META.sec016;
  const [result, setResult] = useState<
    | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
    | { kind: "queued"; pendingAttachments?: number }
    | null
  >(null);
  const [autoFilledFields, setAutoFilledFields] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [photoRequiredError, setPhotoRequiredError] = useState(false);

  // Guided multi-section flow: Staff → Flight → Security Checks → Attachments →
  // Review. All sections stay mounted (hidden via CSS, not unmounted) so
  // react-hook-form registration, values, and validation are completely
  // unaffected by which step is showing — this is a UX restructure only,
  // not a change to what's required or how it's validated.
  const STEP_LABELS = ["STAFF", "FLIGHT", "SECURITY CHECKS", "ATTACHMENTS", "REVIEW"] as const;
  const [step, setStep] = useState(0);

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
  const { savedAt } = useDraftAutosave("sec016", values);
  const { submit } = useOfflineSubmit("sec016", submitSec016);

  const isArrival = values.flight_type === "arrival";
  const requiresDiscrepancyPhoto = /baggage discrepancy/i.test(values.discrepancies || "");
  const hasPhoto = attachments.some((a) => a.mimeType.startsWith("image/"));

  const onSubmit = handleSubmit(async (v) => {
    setPhotoRequiredError(false);

    // Item 4: a PDF alone must not satisfy the baggage-discrepancy photo
    // requirement — enforced here since attachments upload separately from the
    // report row itself (see useOfflineSubmit / uploadAttachments).
    if (requiresDiscrepancyPhoto && !hasPhoto) {
      setPhotoRequiredError(true);
      setStep(3);
      requestAnimationFrame(() =>
        document.getElementById("sec016-attachments")?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
      return;
    }

    const payload = {
      ...v,
      // Direction-specific fields for the opposite direction are never shown to the
      // user — send them through as empty rather than leaving stale values from a
      // prior direction toggle so they can never surface as "applicable information"
      // for the report actually being filed.
      inbound_baggage: isArrival ? v.inbound_baggage : "",
      inbound_cargo: isArrival ? v.inbound_cargo : "",
      inbound_co_mail: isArrival ? v.inbound_co_mail : "",
      outbound_baggage: isArrival ? "" : v.outbound_baggage,
      outbound_cargo: isArrival ? "" : v.outbound_cargo,
      outbound_co_mail: isArrival ? "" : v.outbound_co_mail,
      offload_baggage_tag_no: isArrival ? "" : v.offload_baggage_tag_no,
      offload_remark: isArrival ? "" : v.offload_remark,
    };

    const parsed = sec016Schema.safeParse(payload);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => {
        setError(issue.path.join(".") as never, { message: issue.message });
      });
      // Jump back to the first section containing an invalid field so the
      // error isn't silently sitting behind a hidden step.
      const firstField = parsed.error.issues[0]?.path[0] as string | undefined;
      setStep(firstField ? (FIELD_STEP[firstField] ?? 0) : 0);
      return;
    }

    const outcome = await submit(
      parsed.data,
      attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size, blob: a.blob })),
    );
    if (outcome.kind === "submitted") {
      clearLocalDraft("sec016");
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
      clearLocalDraft("sec016");
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
          setAutoFilledFields(new Set());
          setPhotoRequiredError(false);
          setStep(0);
          setResult(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Report name, draft status, and section progress */}
      <FormStepIndicator
        code={meta.code}
        draftNote={savedAt ? `DRAFT SAVED ${savedAt.toLocaleTimeString()}` : "AUTOSAVING…"}
        steps={STEP_LABELS}
        activeIndex={step}
      />
      <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider text-center -mt-2.5">
        Step {step + 1} of {STEP_LABELS.length} — {STEP_LABELS[step]}
      </p>

      {/* Step 1 — Staff: Flight Direction, Smart Input, Staff Details */}
      <div className={cn("space-y-5", step !== 0 && "hidden")}>
      <div className="card p-4 space-y-3 border-primary/40 bg-surface/80">
        <div className="flex items-center justify-between">
          <label className="field-label block font-semibold text-xs tracking-wider uppercase text-foreground">
            Flight Direction <span className="text-red-500">*</span>
          </label>
          <span className="t-mono text-[10px] uppercase font-bold text-primary">
            {isArrival ? "Auto Bay Board Addition" : "Auto Bay Board Clearance"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setValue("flight_type", "arrival", { shouldDirty: true, shouldValidate: true })}
            className={cn(
              "flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border font-bold text-sm transition-all cursor-pointer",
              isArrival
                ? "bg-emerald-500/15 border-emerald-500 text-emerald-400 shadow-sm"
                : "bg-surface border-border text-muted-foreground hover:border-border/80"
            )}
          >
            <PlaneLanding className="h-4 w-4 text-emerald-400" />
            <span>Arrival (ARR)</span>
          </button>
          <button
            type="button"
            onClick={() => setValue("flight_type", "departure", { shouldDirty: true, shouldValidate: true })}
            className={cn(
              "flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl border font-bold text-sm transition-all cursor-pointer",
              !isArrival
                ? "bg-sky-500/15 border-sky-500 text-sky-400 shadow-sm"
                : "bg-surface border-border text-muted-foreground hover:border-border/80"
            )}
          >
            <PlaneTakeoff className="h-4 w-4 text-sky-400" />
            <span>Departure (DEP)</span>
          </button>
        </div>
      </div>

      {!isArrival && (
        <div className="card p-4 space-y-2 border-amber-500/30 bg-amber-500/5">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              {...register("aircraft_search_completed")}
              className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
            />
            <div>
              <p className="text-xs font-bold text-foreground">
                Aircraft Search Completed (SEC 029)
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Recommended if aircraft has been on ground for $\ge$ 4 hours. If not completed, an audit remark will be logged automatically on this departure report.
              </p>
            </div>
          </label>
        </div>
      )}

      {/* 3. Smart Input */}
      <SmartInputSec016 setValue={setValue} onParsed={setAutoFilledFields} />

      {/* 4. Staff Details */}
      <FormSection title="Staff Details">
        <p className="field-hint">Email: {profile.email}</p>
        <FieldRow>
          <SelectField name="station" register={register} label="Station" required options={STATIONS} error={errors.station} />
          <TextField name="team" register={register} label="Team" required placeholder="e.g. Alpha" error={errors.team} />
        </FieldRow>
        <FieldRow>
          <TextField name="staff_name" register={register} label="Name" required error={errors.staff_name} />
          <TextField name="staff_no" register={register} label="Staff No" required error={errors.staff_no} />
        </FieldRow>
        <FieldRow>
          <TextField name="duty_date" type="date" register={register} label="Date" required error={errors.duty_date as never} autoFilled={autoFilledFields.has("duty_date")} />
          <TextField name="duty_hour" type="time" register={register} label="Duty Hour" required error={errors.duty_hour as never} />
        </FieldRow>
      </FormSection>

      <StepNavButtons step={step} setStep={setStep} lastStep={STEP_LABELS.length - 1} />
      </div>

      {/* Step 2 — Flight: Aircraft details, Ramp Loading Supervisor */}
      <div className={cn("space-y-5", step !== 1 && "hidden")}>
      {/* 5. Aircraft details */}
      <FormSection title="Aircraft">
        <FieldRow>
          <TextField name="flight" register={register} label="Flight" required error={errors.flight} autoFilled={autoFilledFields.has("flight")} />
          <TextField
            name="origin_arr_dep"
            register={register}
            label={isArrival ? "Origin (Arrival)" : "Destination (Departure)"}
            required
            error={errors.origin_arr_dep}
            autoFilled={autoFilledFields.has("origin_arr_dep")}
          />
        </FieldRow>
        <TextField name="assisted_by" register={register} label="Assisted By" required error={errors.assisted_by} autoFilled={autoFilledFields.has("assisted_by")} />

        <RadioGroupField
          name="aircraft_type"
          register={register}
          label="Aircraft Type"
          required
          columns={4}
          options={["A 320", "A 321", "A 330", "Other"]}
          error={errors.aircraft_type as never}
          autoFilled={autoFilledFields.has("aircraft_type")}
        />
        {values.aircraft_type === "Other" && (
          <TextField
            name="aircraft_type_other"
            register={register}
            label="Specify aircraft type"
            required
            error={errors.aircraft_type_other}
          />
        )}

        <FieldRow>
          <TextField name="reg_no" register={register} label="Reg No" required error={errors.reg_no} autoFilled={autoFilledFields.has("reg_no")} />
          <TextField name="bay_no" register={register} label="Bay No" required error={errors.bay_no} autoFilled={autoFilledFields.has("bay_no")} />
        </FieldRow>
        <FieldRow>
          <TextField
            name="sta_std"
            type="time"
            register={register}
            label={isArrival ? "STA" : "STD"}
            required
            error={errors.sta_std as never}
            autoFilled={autoFilledFields.has("sta_std")}
          />
          <TextField
            name="ata_atd"
            type="time"
            register={register}
            label={isArrival ? "ATA" : "ATD"}
            required
            error={errors.ata_atd as never}
            autoFilled={autoFilledFields.has("ata_atd")}
          />
        </FieldRow>
        <TextField name="reason_for_delay" register={register} label="Reason for Delay" error={errors.reason_for_delay} autoFilled={autoFilledFields.has("reason_for_delay")} />
        <RadioGroupField name="do_infmd" register={register} label="D/O INFMD" required options={["YES", "NO"]} error={errors.do_infmd as never} autoFilled={autoFilledFields.has("do_infmd")} />

        {/* 6. Direction-specific baggage, cargo, and Co-Mail / Comat */}
        {isArrival ? (
          <>
            <TextField name="inbound_baggage" register={register} label="Inbound Baggage" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.inbound_baggage} autoFilled={autoFilledFields.has("inbound_baggage")} />
            <TextField name="inbound_cargo" register={register} label="Inbound Cargo" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.inbound_cargo} autoFilled={autoFilledFields.has("inbound_cargo")} />
            <TextField name="inbound_co_mail" register={register} label="Inbound Co-Mail / Comat" required naFillable setValue={setValue} error={errors.inbound_co_mail} autoFilled={autoFilledFields.has("inbound_co_mail")} />
          </>
        ) : (
          <>
            <TextField name="outbound_baggage" register={register} label="Outbound Baggage" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.outbound_baggage} autoFilled={autoFilledFields.has("outbound_baggage")} />
            <TextField name="outbound_cargo" register={register} label="Outbound Cargo" hint="Trolley / Container(s)" required naFillable setValue={setValue} error={errors.outbound_cargo} autoFilled={autoFilledFields.has("outbound_cargo")} />
            <TextField name="outbound_co_mail" register={register} label="Outbound Co-Mail / Comat" required naFillable setValue={setValue} error={errors.outbound_co_mail} autoFilled={autoFilledFields.has("outbound_co_mail")} />
          </>
        )}
      </FormSection>

      {/* 7. Ramp Loading Supervisor (RLS) */}
      <FormSection title="Ramp Loading Supervisor">
        <TextField name="shift_leader" register={register} label="Ramp Loading Supervisor (RLS)" hint="Name & ID" required error={errors.shift_leader} autoFilled={autoFilledFields.has("shift_leader")} />

        {/* 8 & 9. Ramp agent details */}
        <RampAgentsField name="ramp_agents_baggage" label="Ramp agent details (baggage)" register={register} error={errors.ramp_agents_baggage} />
        <RampAgentsField name="ramp_agents_cargo" label="Ramp agent details (cargo)" register={register} error={errors.ramp_agents_cargo} />
      </FormSection>

      <StepNavButtons step={step} setStep={setStep} lastStep={STEP_LABELS.length - 1} />
      </div>

      {/* Step 3 — Security Checks: checks, discrepancies, offload info */}
      <div className={cn("space-y-5", step !== 2 && "hidden")}>
      {/* 10. Security Checks */}
      <FormSection title="Security Checks">
        <div>
          <RadioGroupField name="cargo_hold_checked" register={register} label="Cargo Hold Checked" required options={["YES", "NO"]} error={errors.cargo_hold_checked as never} autoFilled={autoFilledFields.has("cargo_hold_checked")} />
          <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1.5">
            {isArrival
              ? "Ensure baggage, cargo, mail, courier bags, etc. are offloaded from the aircraft hold."
              : "Ensure baggage, cargo, mail, courier bags, etc. are loaded into the aircraft hold."}
          </p>
        </div>
        <RadioGroupField name="staff_frisked" register={register} label="Staff Frisked" required options={["YES", "NO"]} error={errors.staff_frisked as never} autoFilled={autoFilledFields.has("staff_frisked")} />
        <RadioGroupField name="cabin_check" register={register} label="Cabin Check" options={["YES", "NO"]} error={errors.cabin_check as never} autoFilled={autoFilledFields.has("cabin_check")} />
      </FormSection>

      {/* 11. Discrepancies */}
      <FormSection title="Discrepancies">
        <TextAreaField name="discrepancies" register={register} label="Discrepancies (if any)" required rows={3} error={errors.discrepancies} />
        <div className="flex flex-wrap gap-1.5">
          {DISCREPANCY_QUICK_ADDS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() =>
                setValue(
                  "discrepancies",
                  ((values.discrepancies ? values.discrepancies.trim() + ". " : "") + text) as never,
                  { shouldDirty: true, shouldValidate: true },
                )
              }
              className="font-mono text-[10.5px] font-medium px-2.5 py-1 rounded border border-dashed border-border/80 text-muted-foreground bg-surface/40 hover:border-primary hover:text-primary hover:bg-primary/5 transition-all cursor-pointer"
            >
              + {text}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground italic">
          Example — Incident reported: &ldquo;Incident reported — refer email from DSE/duty officer.&rdquo;
        </p>

        {requiresDiscrepancyPhoto && (
          <div
            className={cn(
              "card-inset p-3 rounded-lg border flex items-start gap-2.5",
              hasPhoto ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/50 bg-amber-500/10"
            )}
          >
            <Camera className={cn("h-4 w-4 mt-0.5 shrink-0", hasPhoto ? "text-emerald-400" : "text-amber-400")} />
            <p className="text-xs font-semibold text-foreground">
              {hasPhoto
                ? "Photo attached for baggage discrepancy."
                : "Baggage discrepancy selected — at least one photo is required before this report can be submitted. A PDF alone does not satisfy this requirement."}
            </p>
          </div>
        )}
      </FormSection>

      {/* 12 & 13. Offload Information — Departure only */}
      {!isArrival && (
        <FormSection title="Offload Information (Departure Flight)">
          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="field-label" htmlFor="offload_baggage_tag_no">
                Baggage Tag No <span className="text-red-400">*</span>
              </label>
              <button
                type="button"
                className="btn-quiet -mt-1 text-xs"
                onClick={() => setValue("offload_baggage_tag_no", "N/A" as never, { shouldValidate: true, shouldDirty: true })}
              >
                N/A
              </button>
            </div>
            <textarea
              id="offload_baggage_tag_no"
              rows={4}
              className="input-base font-mono text-xs leading-relaxed"
              {...register("offload_baggage_tag_no")}
            />
            <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">
              Enter one baggage tag number per line.
            </p>
            {errors.offload_baggage_tag_no?.message && (
              <p className="text-xs text-red-400 font-mono mt-1.5">{errors.offload_baggage_tag_no.message}</p>
            )}
          </div>

          <TextAreaField name="offload_remark" register={register} label="Remark" required error={errors.offload_remark} />
          <div className="flex flex-wrap gap-1.5">
            {OFFLOAD_QUICK_ADDS.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() =>
                  setValue(
                    "offload_remark",
                    ((values.offload_remark ? values.offload_remark.trim() + ". " : "") + text) as never,
                    { shouldDirty: true, shouldValidate: true },
                  )
                }
                className="font-mono text-[10.5px] font-medium px-2.5 py-1 rounded border border-dashed border-border/80 text-muted-foreground bg-surface/40 hover:border-primary hover:text-primary hover:bg-primary/5 transition-all cursor-pointer"
              >
                + {text}
              </button>
            ))}
          </div>
        </FormSection>
      )}

      <StepNavButtons step={step} setStep={setStep} lastStep={STEP_LABELS.length - 1} />
      </div>

      {/* Step 4 — Attachments */}
      <div className={cn("space-y-5", step !== 3 && "hidden")}>
      {/* 14. Attachments */}
      <div id="sec016-attachments">
        <AttachmentUpload value={attachments} onChange={setAttachments} disabled={isSubmitting} />
        {photoRequiredError && (
          <p className="text-xs text-red-400 font-mono mt-2">
            ⚠ Add at least one photo before submitting — baggage discrepancy was reported and a PDF alone isn&apos;t enough.
          </p>
        )}
      </div>

      <StepNavButtons step={step} setStep={setStep} lastStep={STEP_LABELS.length - 1} />
      </div>

      {/* Step 5 — Review: read-only summary before submit */}
      <div className={cn("space-y-5", step !== 4 && "hidden")}>
        <FormSection title="Review" note="Check the details below, then submit. Go back to any section to make changes.">
          <ReviewRow label="Flight Direction" value={isArrival ? "Arrival (ARR)" : "Departure (DEP)"} />
          <ReviewRow label="Station / Team" value={`${values.station || "—"} / ${values.team || "—"}`} />
          <ReviewRow label="Staff" value={`${values.staff_name || "—"} (${values.staff_no || "—"})`} />
          <ReviewRow label="Date / Duty Hour" value={`${values.duty_date || "—"} ${values.duty_hour || ""}`} />
          <ReviewRow label="Flight" value={values.flight || "—"} />
          <ReviewRow label={isArrival ? "Origin" : "Destination"} value={values.origin_arr_dep || "—"} />
          <ReviewRow label="Aircraft Type" value={values.aircraft_type === "Other" ? values.aircraft_type_other || "—" : values.aircraft_type} />
          <ReviewRow label="Reg No / Bay No" value={`${values.reg_no || "—"} / ${values.bay_no || "—"}`} />
          <ReviewRow label="Ramp Loading Supervisor" value={values.shift_leader || "—"} />
          <ReviewRow label="Cargo Hold Checked" value={values.cargo_hold_checked} />
          <ReviewRow label="Staff Frisked" value={values.staff_frisked} />
          <ReviewRow label="Discrepancies" value={values.discrepancies || "—"} />
          <ReviewRow label="Attachments" value={`${attachments.length} file${attachments.length === 1 ? "" : "s"}`} />
        </FormSection>

        {Object.keys(errors).length > 0 && (
          <p className="text-xs text-red-400 font-mono text-center">
            Some required fields are incomplete — submitting will jump back to the first one.
          </p>
        )}

        {/* 15. Submit report and immutability notice */}
        <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
          {isSubmitting ? "Submitting…" : "Submit report ▸"}
        </button>
        <p className="text-center font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          SUBMITTED REPORTS ARE IMMUTABLE · CORRECTIONS ARE FILED AS AMENDMENTS
        </p>
        <button type="button" className="btn-secondary w-full" onClick={() => setStep(3)}>
          ← Back
        </button>
      </div>
    </form>
  );
}

function ReviewRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-sm text-foreground text-right">{value || "—"}</span>
    </div>
  );
}

function StepNavButtons({
  step,
  setStep,
  lastStep,
}: {
  step: number;
  setStep: (s: number) => void;
  lastStep: number;
}) {
  return (
    <div className="flex gap-3">
      {step > 0 && (
        <button type="button" className="btn-secondary flex-1" onClick={() => setStep(step - 1)}>
          ← Back
        </button>
      )}
      {step < lastStep && (
        <button type="button" className="btn-primary flex-1" onClick={() => setStep(step + 1)}>
          Next →
        </button>
      )}
    </div>
  );
}
