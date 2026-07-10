"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  DIRECTION_TRUCK_SEAL_COLOR,
  SEAL_COLOR_LABELS,
  SEAL_TYPE_LABELS,
} from "@/lib/constants";
import type { Direction, SealColor, SealType } from "@/lib/database.types";

export interface SealDraft {
  seal_number: string;
  seal_type: SealType;
  seal_color: SealColor;
}

interface SealEditorProps {
  direction: Direction;
  seals: SealDraft[];
  onChange: (seals: SealDraft[]) => void;
}

/**
 * Add-multiple-seals editor for Part A. Truck seal color is locked to the
 * direction (blue outbound / green inbound); trolley/other seals may vary.
 */
export function SealEditor({ direction, seals, onChange }: SealEditorProps) {
  const requiredColor = DIRECTION_TRUCK_SEAL_COLOR[direction];

  const update = (i: number, patch: Partial<SealDraft>) => {
    const next = seals.map((s, idx) => {
      if (idx !== i) return s;
      const merged = { ...s, ...patch };
      if (merged.seal_type === "TRUCK_SEAL") merged.seal_color = requiredColor;
      return merged;
    });
    onChange(next);
  };

  const add = () =>
    onChange([...seals, { seal_number: "", seal_type: "TROLLEY", seal_color: requiredColor }]);

  const remove = (i: number) => onChange(seals.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          Seals ({requiredColor === "BLUE" ? "blue" : "green"} truck seal required)
        </Label>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" /> Add seal
        </Button>
      </div>
      {seals.map((seal, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
          <Input
            aria-label={`Seal ${i + 1} number`}
            placeholder="Seal number"
            value={seal.seal_number}
            onChange={(e) => update(i, { seal_number: e.target.value })}
            required
          />
          <Select
            aria-label={`Seal ${i + 1} type`}
            className="w-auto"
            value={seal.seal_type}
            onChange={(e) => update(i, { seal_type: e.target.value as SealType })}
          >
            {Object.entries(SEAL_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select
            aria-label={`Seal ${i + 1} color`}
            className="w-auto"
            value={seal.seal_color}
            disabled={seal.seal_type === "TRUCK_SEAL"}
            onChange={(e) => update(i, { seal_color: e.target.value as SealColor })}
          >
            {Object.entries(SEAL_COLOR_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove seal ${i + 1}`}
            onClick={() => remove(i)}
            disabled={seals.length === 1}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        The truck seal color is fixed by direction. Every seal is re-verified by number at each
        checkpoint.
      </p>
    </div>
  );
}
