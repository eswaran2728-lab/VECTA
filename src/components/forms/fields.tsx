"use client";

import type {
  FieldError,
  FieldValues,
  Path,
  UseFormRegister,
  UseFormSetValue,
} from "react-hook-form";
import { cn } from "@/lib/utils";

function ErrorText({ error }: { error?: FieldError }) {
  if (!error) return null;
  return <p className="field-error">{error.message}</p>;
}

// Selectable chip — square, thin-bordered, gold when picked. The <input> inside is
// visually hidden (sr-only) so the label itself is the control, letting `has-[:checked]`
// drive the styling while keeping it keyboard- and screen-reader-accessible.
const CHIP_BASE =
  "flex items-center gap-2 px-3 py-3 min-h-[48px] text-sm font-semibold cursor-pointer transition-colors " +
  "border border-[var(--line3)] bg-transparent text-[var(--mid)] " +
  "has-[:checked]:border-[var(--gold-fill)] has-[:checked]:bg-[var(--gold-soft)] has-[:checked]:text-[var(--gold)] " +
  "has-[:focus-visible]:border-[var(--gold-fill)] hover:border-[var(--soft)]";

interface BaseProps<T extends FieldValues> {
  name: Path<T>;
  register: UseFormRegister<T>;
  label: string;
  required?: boolean;
  hint?: string;
  error?: FieldError;
  className?: string;
  /** Marks the field as populated by Smart Input paste-to-autofill, for a visual cue. */
  autoFilled?: boolean;
}

function AutoFilledBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 t-mono text-[9px] font-semibold uppercase"
      style={{ letterSpacing: "0.1em", color: "var(--green)" }}
    >
      ✦ Auto-filled
    </span>
  );
}

export function TextField<T extends FieldValues>({
  name,
  register,
  label,
  required,
  hint,
  error,
  className,
  type = "text",
  placeholder,
  naFillable,
  setValue,
  inputMode,
  autoFilled,
}: BaseProps<T> & {
  type?: string;
  placeholder?: string;
  naFillable?: boolean;
  setValue?: UseFormSetValue<T>;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <label className="field-label" htmlFor={name}>
          {label}
          {required && <span style={{ color: "var(--red)" }}> *</span>}
        </label>
        <div className="flex items-center gap-2 shrink-0">
          {autoFilled && <AutoFilledBadge />}
          {naFillable && setValue && (
            <button
              type="button"
              className="btn-quiet -mt-1"
              onClick={() => setValue(name, "N/A" as never, { shouldValidate: true, shouldDirty: true })}
            >
              N/A
            </button>
          )}
        </div>
      </div>
      <input
        id={name}
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        className={cn("input-base", autoFilled && "border-[var(--green)]")}
        {...register(name)}
      />
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function TextAreaField<T extends FieldValues>({
  name,
  register,
  label,
  required,
  hint,
  error,
  className,
  rows = 3,
}: BaseProps<T> & { rows?: number }) {
  return (
    <div className={className}>
      <label className="field-label" htmlFor={name}>
        {label}
        {required && <span style={{ color: "var(--red)" }}> *</span>}
      </label>
      <textarea id={name} rows={rows} className="input-base" {...register(name)} />
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function SelectField<T extends FieldValues>({
  name,
  register,
  label,
  required,
  hint,
  error,
  className,
  options,
  placeholder = "Select…",
}: BaseProps<T> & { options: readonly string[]; placeholder?: string }) {
  return (
    <div className={className}>
      <label className="field-label" htmlFor={name}>
        {label}
        {required && <span style={{ color: "var(--red)" }}> *</span>}
      </label>
      <select id={name} className="input-base" defaultValue="" {...register(name)}>
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function RadioGroupField<T extends FieldValues>({
  name,
  register,
  label,
  required,
  hint,
  error,
  className,
  options,
  columns = 2,
  autoFilled,
}: BaseProps<T> & { options: readonly string[]; columns?: 2 | 3 | 4 }) {
  const gridCols = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" }[columns];
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <label className="field-label">
          {label}
          {required && <span style={{ color: "var(--red)" }}> *</span>}
        </label>
        {autoFilled && <AutoFilledBadge />}
      </div>
      <div className={cn("grid gap-2", gridCols)}>
        {options.map((opt) => (
          <label key={opt} className={cn(CHIP_BASE, "justify-center")}>
            <input type="radio" value={opt} className="sr-only" {...register(name)} />
            {opt}
          </label>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function CheckboxGroupField<T extends FieldValues>({
  name,
  register,
  label,
  required,
  hint,
  error,
  className,
  options,
}: BaseProps<T> & { options: readonly string[] }) {
  return (
    <div className={className}>
      <label className="field-label">
        {label}
        {required && <span style={{ color: "var(--red)" }}> *</span>}
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {options.map((opt) => (
          <label key={opt} className={CHIP_BASE}>
            <input type="checkbox" value={opt} className="sr-only" {...register(name)} />
            {opt}
          </label>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

/** Acknowledgement gate — the square check box the prototype uses before submit. */
export function CheckboxField<T extends FieldValues>({
  name,
  register,
  label,
  error,
  className,
}: Omit<BaseProps<T>, "required" | "hint">) {
  return (
    <div className={className}>
      <label
        className="flex items-start gap-3 p-4 cursor-pointer transition-colors
          border border-[var(--line3)] bg-[var(--panel)]
          has-[:checked]:border-[var(--gold-fill)]"
      >
        <input type="checkbox" className="peer sr-only" {...register(name)} />
        <span
          className="w-[22px] h-[22px] shrink-0 flex items-center justify-center t-mono text-xs font-bold
            border border-[var(--line3)] text-transparent
            peer-checked:border-[var(--gold-fill)] peer-checked:bg-[var(--gold-fill)]
            peer-checked:text-[var(--on-gold)] peer-focus-visible:border-[var(--gold-fill)]"
          aria-hidden
        >
          ✓
        </span>
        <span className="text-[11.5px] leading-relaxed" style={{ color: "var(--mid)" }}>
          {label}
        </span>
      </label>
      <ErrorText error={error} />
    </div>
  );
}

export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
}

/** Sticky-feeling progress header shown at the top of every report form. */
export function FormStepIndicator({
  code,
  draftNote,
  steps = ["STAFF", "DETAILS", "SUBMIT"],
  activeIndex,
}: {
  code: string;
  draftNote: string;
  steps?: readonly string[];
  activeIndex: number;
}) {
  return (
    <div className="card-inset px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="t-mono text-[9.5px]" style={{ color: "var(--soft)" }}>
          {code}
        </span>
        <span
          className="t-mono text-[9.5px] font-semibold"
          style={{ letterSpacing: "0.1em", color: "var(--gold)" }}
        >
          {draftNote}
        </span>
      </div>
      <div className="flex gap-1.5 mt-2.5">
        {steps.map((label, i) => {
          const on = i <= activeIndex;
          return (
            <div key={label} className="flex-1 min-w-0">
              <div className="h-[3px]" style={{ background: on ? "var(--gold-fill)" : "var(--line3)" }} />
              <div
                className="t-mono text-[8px] mt-1.5 whitespace-nowrap overflow-hidden text-ellipsis"
                style={{ letterSpacing: "0.08em", color: on ? "var(--ink)" : "var(--faint)" }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Wrapper for one row of a repeating field-array (patrol entry, hold check, duty …). */
export function EntryCard({
  label,
  onRemove,
  children,
}: {
  label: string;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card-inset p-3">
      <div className="flex items-center justify-between gap-2">
        <span
          className="t-mono text-[10px] font-semibold uppercase"
          style={{ letterSpacing: "0.12em", color: "var(--ink2)" }}
        >
          {label}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="t-mono text-[9px] font-semibold uppercase"
            style={{ color: "var(--red)" }}
          >
            Remove
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3 mt-3">{children}</div>
    </div>
  );
}

export const DEFAULT_REMARK_PHRASES = [
  "Nil",
  "No discrepancies found",
  "PIC informed",
  "Escorted to control point",
  "Supervisor notified",
] as const;

/** Tap-to-append quick phrases shown under a remark / discrepancies textarea. */
export function RemarkQuickPhrases({
  value,
  onChange,
  phrases = DEFAULT_REMARK_PHRASES,
}: {
  value: string;
  onChange: (next: string) => void;
  phrases?: readonly string[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2.5">
      {phrases.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onChange((value ? value.trim() + ". " : "") + text)}
          className="t-mono text-[10px] font-medium px-2.5 py-1.5 border border-dashed border-[var(--line3)] text-[var(--mid)] hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors"
        >
          + {text}
        </button>
      ))}
    </div>
  );
}

export function FormSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4 sm:p-5 space-y-4">
      <h2 className="section-title">{title}</h2>
      {note && (
        <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--soft)" }}>
          {note}
        </p>
      )}
      {children}
    </section>
  );
}
