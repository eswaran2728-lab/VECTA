import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DIRECTION_COLORS, DIRECTION_LABELS } from "@/lib/constants";
import type { Direction } from "@/lib/database.types";

/** Blue = outbound (departure), green = inbound (arrival) — matches truck seal colors. */
export function DirectionBadge({ direction }: { direction: Direction }) {
  const Icon = direction === "OUTBOUND" ? ArrowUpRight : ArrowDownLeft;
  return (
    <Badge className={`${DIRECTION_COLORS[direction]} gap-1`}>
      <Icon className="h-3 w-3" />
      {DIRECTION_LABELS[direction]}
    </Badge>
  );
}
