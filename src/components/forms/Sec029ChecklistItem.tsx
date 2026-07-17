"use client";

import type { FieldValues, Path, UseFormRegister, UseFormWatch, UseFormSetValue, FieldErrors } from "react-hook-form";
import { cn } from "@/lib/utils";

export function Sec029ChecklistItem<T extends FieldValues>({
  index,
  label,
  allowNotApplicable,
  register,
  watch,
  setValue,
  errors,
}: {
  index: number;
  label: string;
  allowNotApplicable?: boolean;
  register: UseFormRegister<T>;
  watch: UseFormWatch<T>;
  setValue: UseFormSetValue<T>;
  errors: FieldErrors<T>;
}) {
  const checkedName = `items.${index}.checked` as Path<T>;
  const remarkTypeName = `items.${index}.remark_type` as Path<T>;
  const remarkTextName = `items.${index}.remark_text` as Path<T>;

  const checked = watch(checkedName) as unknown as string;
  const remarkType = watch(remarkTypeName) as unknown as string;
  const flagged = checked === "NO" || remarkType === "other";

  const checkedOptions: ("YES" | "NO" | "NA")[] = allowNotApplicable ? ["YES", "NO", "NA"] : ["YES", "NO"];

  const itemErrors = (errors as Record<string, unknown>).items as
    | { [key: number]: { remark_text?: { message?: string } } }
    | undefined;

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-3",
        flagged
          ? "border-amber-400 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-600"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      <p className="font-medium text-sm">{label}</p>

      <div>
        <p className="field-hint mb-1">CHECKED</p>
        <div className={cn("grid gap-2", allowNotApplicable ? "grid-cols-3" : "grid-cols-2")}>
          {checkedOptions.map((opt) => (
            <label
              key={opt}
              className="flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-slate-700
                px-2 py-2 min-h-[44px] text-sm font-medium cursor-pointer
                has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
                dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
            >
              <input type="radio" value={opt} className="accent-brand-600" {...register(checkedName)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="field-hint mb-1">REMARK / DETECTION</p>
        <div className={cn("grid gap-2", allowNotApplicable ? "grid-cols-3" : "grid-cols-2")}>
          <label
            className="flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-slate-700
              px-2 py-2 min-h-[44px] text-sm font-medium cursor-pointer
              has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
              dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
          >
            <input type="radio" value="nil" className="accent-brand-600" {...register(remarkTypeName)} />
            Checked with nil issues
          </label>
          <label
            className="flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-slate-700
              px-2 py-2 min-h-[44px] text-sm font-medium cursor-pointer
              has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
              dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
          >
            <input type="radio" value="other" className="accent-brand-600" {...register(remarkTypeName)} />
            Other:
          </label>
          {allowNotApplicable && (
            <label
              className="flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-slate-700
                px-2 py-2 min-h-[44px] text-sm font-medium cursor-pointer
                has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-800
                dark:has-[:checked]:bg-brand-900/30 dark:has-[:checked]:text-brand-200"
              onClick={() => setValue(checkedName, "NA" as never)}
            >
              <input type="radio" value="na" className="accent-brand-600" {...register(remarkTypeName)} />
              Not Applicable
            </label>
          )}
        </div>
        {remarkType === "other" && (
          <div className="mt-2">
            <input
              className="input-base"
              placeholder="Describe the detection / issue"
              {...register(remarkTextName)}
            />
            {itemErrors?.[index]?.remark_text && (
              <p className="field-error">{itemErrors[index]?.remark_text?.message}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
