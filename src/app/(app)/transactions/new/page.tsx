import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { CREATOR_DIRECTIONS, WORKFLOWS } from "@/lib/workflow";
import { DirectionBadge } from "@/components/direction-badge";
import { PartAForm } from "./part-a-form";

export const metadata: Metadata = { title: "New Transaction (Part A)" };
export const dynamic = "force-dynamic";

export default async function NewTransactionPage() {
  const profile = await requireRole(["warehouse_pic", "sra_warehouse_pic"]);
  const direction = CREATOR_DIRECTIONS[profile.role]!;
  const flow = ["A · Warehouse", ...WORKFLOWS[direction].map((s) => s.shortLabel)].join("  →  ");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">
          Part A — {direction === "OUTBOUND" ? "Warehouse Dispatch" : "SRA Warehouse Dispatch"}
        </h1>
        <DirectionBadge direction={direction} />
        <p className="text-sm text-muted-foreground">
          Complete the vehicle search and seal the load. A transaction number and QR pass are
          generated on submit.
        </p>
        <p className="rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
          {flow}
        </p>
      </div>
      <PartAForm
        picName={profile.name}
        picStaffId={profile.staff_id}
        direction={direction}
      />
    </div>
  );
}
