/**
 * Small 5-color semantic status indicator — a real circular dot next to a
 * text label, never a large color block or an emoji glyph. Flat solid
 * fill, no glow/shadow, per the de-neon design pass.
 */
export type OpsStatus = "operational" | "attention" | "critical" | "information" | "standby";

const STATUS_META: Record<OpsStatus, { label: string; color: string }> = {
  operational: { label: "Operational", color: "var(--green)" },
  attention: { label: "Attention", color: "oklch(var(--warning))" },
  critical: { label: "Critical", color: "var(--red)" },
  information: { label: "Information", color: "var(--cyan)" },
  standby: { label: "Standby", color: "oklch(var(--muted-foreground))" },
};

export function StatusDot({
  status,
  label,
  className = "",
}: {
  status: OpsStatus;
  /** Override the default label text; the dot color still follows `status`. */
  label?: string;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground ${className}`}>
      <span
        aria-hidden
        className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      {label ?? meta.label}
    </span>
  );
}
