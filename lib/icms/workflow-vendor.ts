import type { Role, VendorTransactionStatus } from "./database.types";

/**
 * Single source of truth for the Vendor Movement Module's checkpoint
 * sequence (AA/SEC/F/019). Mirrors workflow.ts's shape but is a flat
 * two-step sequence, not direction-aware — mirrored in Postgres by
 * enforce_vendor_part_sequence() / enforce_vendor_part_c_sequence()
 * (supabase/migrations/20260813000002_vendor_movement.sql).
 */

export type VendorCheckpointPart = "part_b" | "part_c";

export interface VendorCheckpointStep {
  part: VendorCheckpointPart;
  slug: string;
  label: string;
  shortLabel: string;
  role: Role;
  requiredStatus: VendorTransactionStatus[];
  finalizes: boolean;
}

export const VENDOR_WORKFLOW: VendorCheckpointStep[] = [
  {
    part: "part_b",
    slug: "part-b",
    label: "Part B — AirAsia Security (Post 2)",
    shortLabel: "B · Post 2",
    role: "post2_avsec",
    requiredStatus: ["CREATED"],
    finalizes: false,
  },
  {
    part: "part_c",
    slug: "part-c",
    label: "Part C — Warehouse (In-Flight)",
    shortLabel: "C · Warehouse",
    role: "warehouse_pic",
    requiredStatus: ["SECURITY_VERIFIED", "PART_C_PARTIAL"],
    finalizes: true,
  },
];

export function vendorNextStepFor(
  status: VendorTransactionStatus
): VendorCheckpointStep | null {
  if (status === "COMPLETED" || status === "ESCALATED") return null;
  return VENDOR_WORKFLOW.find((s) => s.requiredStatus.includes(status)) ?? null;
}
