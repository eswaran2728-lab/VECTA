"use client";

import type {
  FieldError,
  FieldValues,
  Path,
  UseFormRegister,
  UseFormSetValue,
} from "react-hook-form";
import { cn } from "@/lib/avsec/utils";

function ErrorText({ error }: { error?: FieldError }) {
  if (!error) return null;
  return <p className="text-xs text-red-400 font-mono mt-1.5">{error.message}</p>;
}

// Selectable chip — modern Nocturne tile that lights up with cyan/primary accent when selected
const CHIP_BASE =
  "flex items-center gap-2 px-3 py-3 min-h-[48px] text-xs font-mono font-semibold cursor-pointer transition-all rounded-lg " +
  "border border-border/70 bg-surface/50 text-muted-foreground " +
  "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:checked]:shadow-sm " +
  "has-[:focus-visible]:border-primary hover:border-border hover:bg-surface hover:text-foreground";

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
      className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-emerald-400"
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
          {required && <span className="text-red-400"> *</span>}
        </label>
        <div className="flex items-center gap-2 shrink-0">
          {autoFilled && <AutoFilledBadge />}
          {naFillable && setValue && (
            <button
              type="button"
              className="btn-quiet -mt-1 text-xs"
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
        className={cn("input-base", autoFilled && "border-emerald-500/80 focus:border-emerald-400 focus:ring-emerald-400/20")}
        {...register(name)}
      />
      {hint && <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">{hint}</p>}
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
        {required && <span className="text-red-400"> *</span>}
      </label>
      <textarea id={name} rows={rows} className="input-base" {...register(name)} />
      {hint && <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">{hint}</p>}
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
        {required && <span className="text-red-400"> *</span>}
      </label>
      <select id={name} className="input-base" defaultValue="" {...register(name)}>
        <option value="" disabled className="bg-card text-muted-foreground">
          {placeholder}
        </option>
        {options.map((opt) => (
          <option key={opt} value={opt} className="bg-card text-foreground">
            {opt}
          </option>
        ))}
      </select>
      {hint && <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">{hint}</p>}
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
          {required && <span className="text-red-400"> *</span>}
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
      {hint && <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">{hint}</p>}
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
        {required && <span className="text-red-400"> *</span>}
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {options.map((opt) => (
          <label key={opt} className={CHIP_BASE}>
            <input type="checkbox" value={opt} className="sr-only" {...register(name)} />
            {opt}
          </label>
        ))}
      </div>
      {hint && <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

/** Acknowledgement gate — Nocturne checkbox card before submit. */
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
        className="flex items-start gap-3 p-4 cursor-pointer transition-all rounded-lg
          border border-border/80 bg-surface/70 text-foreground
          has-[:checked]:border-primary/80 has-[:checked]:bg-primary/5 hover:border-border"
      >
        <input type="checkbox" className="peer sr-only" {...register(name)} />
        <span
          className="w-5 h-5 shrink-0 rounded flex items-center justify-center font-mono text-xs font-bold
            border border-border/80 text-transparent bg-surface transition-all
            peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground
            peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40"
          aria-hidden
        >
          ✓
        </span>
        <span className="text-xs leading-relaxed text-muted-foreground peer-checked:text-foreground">
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

/** Sticky progress header shown at the top of every report form. */
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
    <div className="card-inset px-4 py-3 rounded-lg border border-border/70 bg-surface/60">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          {code}
        </span>
        <span className="font-mono text-[10px] font-bold text-primary uppercase tracking-widest">
          {draftNote}
        </span>
      </div>
      <div className="flex gap-2 mt-2.5">
        {steps.map((label, i) => {
          const on = i <= activeIndex;
          const isCurrent = i === activeIndex;
          return (
            <div key={label} className="flex-1 min-w-0">
              <div
                className={cn(
                  "h-1 rounded-full transition-all",
                  isCurrent
                    ? "bg-primary shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                    : on
                    ? "bg-primary/70"
                    : "bg-border/60"
                )}
              />
              <div
                className={cn(
                  "font-mono text-[9px] mt-1.5 whitespace-nowrap overflow-hidden text-ellipsis uppercase tracking-wider font-semibold",
                  on ? "text-foreground" : "text-muted-foreground/60"
                )}
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
    <div className="card-inset p-3.5 rounded-lg border border-border/70 bg-surface/50 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-foreground">
          {label}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="font-mono text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 transition-colors"
          >
            Remove ✕
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
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
          className="font-mono text-[10.5px] font-medium px-2.5 py-1 rounded border border-dashed border-border/80 text-muted-foreground bg-surface/40 hover:border-primary hover:text-primary hover:bg-primary/5 transition-all cursor-pointer"
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
    <section className="card p-4 sm:p-5 space-y-4 border-border/80 bg-card">
      <h2 className="section-title">{title}</h2>
      {note && (
        <p className="text-xs text-muted-foreground leading-relaxed -mt-2">
          {note}
        </p>
      )}
      {children}
    </section>
  );
}

