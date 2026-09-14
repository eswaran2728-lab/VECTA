"use client";

import type { FieldValues, Path, UseFormRegister, UseFormWatch, UseFormSetValue, FieldErrors } from "react-hook-form";
import { cn } from "@/lib/avsec/utils";

const OPTION_BASE =
  "flex items-center justify-center gap-2 px-2 py-2 min-h-[44px] text-xs font-mono font-semibold cursor-pointer transition-all rounded-lg " +
  "border border-border/70 bg-surface/50 text-muted-foreground " +
  "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:text-primary has-[:checked]:shadow-sm " +
  "hover:border-border hover:bg-surface hover:text-foreground";

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
        "card-inset p-3.5 space-y-3 rounded-lg border transition-all",
        flagged
          ? "border-red-500/50 bg-red-500/10"
          : "border-border/70 bg-surface/50"
      )}
    >
      <p className="font-semibold text-xs text-foreground leading-relaxed">{label}</p>

      <div>
        <p className="field-hint text-[10px] font-mono uppercase text-muted-foreground mb-1.5">CHECKED</p>
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
        <p className="field-hint text-[10px] font-mono uppercase text-muted-foreground mb-1.5">REMARK / DETECTION</p>
        <div className={cn("grid gap-2", allowNotApplicable ? "grid-cols-3" : "grid-cols-2")}>
          <label className={OPTION_BASE}>
            <input type="radio" value="nil" className="sr-only" {...register(remarkTypeName)} />
            Nil Issues
          </label>
          <label className={OPTION_BASE}>
            <input type="radio" value="other" className="sr-only" {...register(remarkTypeName)} />
            Other
          </label>
          {allowNotApplicable && (
            <label className={OPTION_BASE} onClick={() => setValue(checkedName, "NA" as never)}>
              <input type="radio" value="na" className="sr-only" {...register(remarkTypeName)} />
              N/A
            </label>
          )}
        </div>
        {remarkType === "other" && (
          <div className="mt-2.5">
            <input
              className="input-base text-xs"
              placeholder="Describe the detection / issue"
              {...register(remarkTextName)}
            />
            {itemErrors?.[index]?.remark_text && (
              <p className="text-xs text-red-400 font-mono mt-1">{itemErrors[index]?.remark_text?.message}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
