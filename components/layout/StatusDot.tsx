/**
 * Small 5-color semantic status indicator — a real circular dot next to a
 * text label, never a large color block or an emoji glyph. Flat solid
 * fill, no glow/shadow, per the de-neon design pass.
 */
export type OpsStatus = "operational" | "attention" | "critical" | "information" | "standby";

const STATUS_META: Record<OpsStatus, { label: string; color: string }> = {
  operational: { label: "Operational", color: "var(--green)" },
  attention: { label: "Attention", color: "oklch(0.79 0.15 85)" },
  critical: { label: "Critical", color: "var(--red)" },
  information: { label: "Information", color: "var(--cyan)" },
  standby: { label: "Standby", color: "oklch(0.64 0.02 250)" },
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
    <span className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground ${className}`}>
      <span
        aria-hidden
        className="inline-block h-[8px] w-[8px] shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      {label ?? meta.label}
    </span>
  );
}
