"use client";

import type { WoisConfidenceTag } from "@/lib/avsec/types";
import { ShieldCheck, Globe, HelpCircle, AlertCircle, AlertTriangle } from "lucide-react";

const TAG_CONFIG: Record<
  WoisConfidenceTag,
  { label: string; icon: typeof ShieldCheck; bg: string; text: string; border: string }
> = {
  VERIFIED: {
    label: "VERIFIED",
    icon: ShieldCheck,
    bg: "bg-success/15",
    text: "text-success",
    border: "border-success/30",
  },
  GENERAL_KNOWLEDGE: {
    label: "GENERAL KNOWLEDGE",
    icon: Globe,
    bg: "bg-primary/15",
    text: "text-primary",
    border: "border-primary/30",
  },
  REQUIRES_SOP: {
    label: "REQUIRES SOP",
    icon: HelpCircle,
    bg: "bg-warning/15",
    text: "text-warning",
    border: "border-warning/30",
  },
  UNCERTAIN: {
    label: "UNCERTAIN",
    icon: AlertCircle,
    bg: "bg-warning/15",
    text: "text-warning",
    border: "border-warning/30",
  },
  ESCALATE: {
    label: "ESCALATE",
    icon: AlertTriangle,
    bg: "bg-destructive/20",
    text: "text-destructive animate-pulse",
    border: "border-destructive/50",
  },
};

export function WoisConfidenceBadge({ tag }: { tag: WoisConfidenceTag }) {
  const config = TAG_CONFIG[tag] || TAG_CONFIG.UNCERTAIN;
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold tracking-wider uppercase border ${config.bg} ${config.text} ${config.border}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {config.label}
    </span>
  );
}
