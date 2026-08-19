"use client";

import type { FieldValues, Path, UseFormRegister, UseFormWatch, UseFormSetValue, FieldErrors } from "react-hook-form";
import { cn } from "@/lib/avsec/utils";

const OPTION_BASE =
  "flex items-center justify-center gap-2 px-2 py-2 min-h-[44px] text-sm font-medium cursor-pointer transition-colors " +
  "border border-[var(--line3)] text-[var(--mid)] " +
  "has-[:checked]:border-[var(--gold-fill)] has-[:checked]:bg-[var(--gold-soft)] has-[:checked]:text-[var(--gold)]";

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
      className="card-inset p-3 space-y-3"
      style={flagged ? { borderColor: "var(--red)", background: "var(--red-panel)" } : undefined}
    >
      <p className="font-medium text-sm" style={{ color: "var(--ink2)" }}>{label}</p>

      <div>
        <p className="field-hint mb-1">CHECKED</p>
        <div className={cn("grid gap-2", allowNotApplicable ? "grid-cols-3" : "grid-cols-2")}>
          {checkedOptions.map((opt) => (
            <label key={opt} className={OPTION_BASE}>
              <input type="radio" value={opt} className="sr-only" {...register(checkedName)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="field-hint mb-1">REMARK / DETECTION</p>
        <div className={cn("grid gap-2", allowNotApplicable ? "grid-cols-3" : "grid-cols-2")}>
          <label className={OPTION_BASE}>
            <input type="radio" value="nil" className="sr-only" {...register(remarkTypeName)} />
            Checked with nil issues
          </label>
          <label className={OPTION_BASE}>
            <input type="radio" value="other" className="sr-only" {...register(remarkTypeName)} />
            Other:
          </label>
          {allowNotApplicable && (
            <label className={OPTION_BASE} onClick={() => setValue(checkedName, "NA" as never)}>
              <input type="radio" value="na" className="sr-only" {...register(remarkTypeName)} />
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
