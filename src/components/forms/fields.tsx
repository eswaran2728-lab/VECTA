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
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
      ✨ Auto-filled
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
          {required && <span className="text-red-500"> *</span>}
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
        className={cn("input-base", autoFilled && "ring-2 ring-emerald-400 dark:ring-emerald-600")}
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
        {required && <span className="text-red-500"> *</span>}
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
        {required && <span className="text-red-500"> *</span>}
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
          {required && <span className="text-red-500"> *</span>}
        </label>
        {autoFilled && <AutoFilledBadge />}
      </div>
      <div className={cn("grid gap-2", gridCols)}>
        {options.map((opt) => (
          <label
            key={opt}
            className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700
              px-3 py-3 min-h-[48px] text-sm font-medium cursor-pointer
              has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
              dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
          >
            <input type="radio" value={opt} className="accent-brand-600" {...register(name)} />
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
        {required && <span className="text-red-500"> *</span>}
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {options.map((opt) => (
          <label
            key={opt}
            className="flex items-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700
              px-3 py-3 min-h-[48px] text-sm font-medium cursor-pointer
              has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
              dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
          >
            <input
              type="checkbox"
              value={opt}
              className="accent-brand-600 h-4 w-4"
              {...register(name)}
            />
            {opt}
          </label>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function CheckboxField<T extends FieldValues>({
  name,
  register,
  label,
  error,
  className,
}: Omit<BaseProps<T>, "required" | "hint">) {
  return (
    <div className={className}>
      <label className="flex items-start gap-3 rounded-lg border border-slate-300 dark:border-slate-700 p-4 cursor-pointer">
        <input type="checkbox" className="mt-0.5 h-5 w-5 accent-brand-600" {...register(name)} />
        <span className="text-sm font-medium">{label}</span>
      </label>
      <ErrorText error={error} />
    </div>
  );
}

export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
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
        <p className="text-xs font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 rounded-md px-3 py-2">
          {note}
        </p>
      )}
      {children}
    </section>
  );
}
