"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SEAL_COLOR_BADGES, SEAL_COLOR_LABELS, SEAL_TYPE_LABELS } from "@/lib/constants";
import { t, type Lang } from "@/lib/i18n";
import type { Seal } from "@/lib/database.types";

interface SealVerifyFieldsProps {
  seals: Pick<Seal, "id" | "seal_type" | "seal_color">[];
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  lang?: Lang;
}

/**
 * Checkpoint seal entry: the officer must ENTER each seal number read off the
 * physical seal — numbers on record are never displayed, so a tick-only or
 * copy-from-screen verification is impossible. The server compares entries
 * against Part A and auto-escalates on any mismatch.
 */
export function SealVerifyFields({ seals, entries, onChange, lang = "en" }: SealVerifyFieldsProps) {
  return (
    <div className="space-y-3">
      <Label>{t(lang, "seal_verification")}</Label>
      {seals.map((seal, i) => (
        <div key={seal.id} className="flex items-center gap-2">
          <Badge className={SEAL_COLOR_BADGES[seal.seal_color]}>
            {SEAL_COLOR_LABELS[seal.seal_color]} {SEAL_TYPE_LABELS[seal.seal_type]}
          </Badge>
          <Input
            aria-label={`Seal ${i + 1} number as read`}
            placeholder={t(lang, "enter_seal_placeholder")}
            autoCapitalize="characters"
            value={entries[seal.id] ?? ""}
            onChange={(e) => onChange({ ...entries, [seal.id]: e.target.value })}
            required
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t(lang, "seal_mismatch_note")}</p>
    </div>
  );
}
