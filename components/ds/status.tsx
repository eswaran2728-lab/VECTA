import { AlertTriangle, CheckCircle2, Clock, Info, Lock, OctagonAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/avsec/utils";

/**
 * Status vocabulary shared by every VECTA screen. Meaning is NEVER carried by colour alone: each tone has its own icon and the
 * label text is always rendered. Colours come from semantic tokens, so both themes meet WCAG AA (tests/design-tokens.test.mts).
 */
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

const TONE: Record<StatusTone, { icon: LucideIcon; cls: string; label: string }> = {
  success: { icon: CheckCircle2, cls: "border-success/40 bg-success/10 text-success", label: "Completed" },
  warning: { icon: Clock, cls: "border-warning/40 bg-warning/10 text-warning", label: "Pending" },
  danger: { icon: OctagonAlert, cls: "border-destructive/40 bg-destructive/10 text-destructive", label: "Critical" },
  info: { icon: Info, cls: "border-primary/40 bg-primary/10 text-primary", label: "Active" },
  neutral: { icon: Info, cls: "border-border bg-muted text-muted-foreground", label: "Status" },
  brand: { icon: AlertTriangle, cls: "border-brand/40 bg-brand/10 text-brand", label: "Attention" },
};

export function statusToneLabel(tone: StatusTone): string {
  return TONE[tone].label;
}

export function StatusBadge({ tone = "neutral", children, className }: { tone?: StatusTone; children: React.ReactNode; className?: string }) {
  const { icon: Icon, cls } = TONE[tone];
  return (
    <span className={cn("inline-flex min-h-[24px] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold", cls, className)} data-tone={tone}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </span>
  );
}

export function ScopeBadge({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-h-[24px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

export { Lock as RestrictedIcon };
