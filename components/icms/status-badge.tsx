import { Badge } from "@/components/icms/ui/badge";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/icms/constants";
import type { TransactionStatus } from "@/lib/icms/database.types";

export function StatusBadge({ status }: { status: TransactionStatus }) {
  return <Badge className={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Badge>;
}
