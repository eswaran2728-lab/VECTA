import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { PartAForm } from "./part-a-form";

export const metadata: Metadata = { title: "New Transaction (Part A)" };
export const dynamic = "force-dynamic";

export default async function NewTransactionPage() {
  const profile = await requireRole(["warehouse_pic"]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Part A — Warehouse Dispatch</h1>
        <p className="text-sm text-muted-foreground">
          Complete the vehicle search and seal the load. A transaction number and QR pass are
          generated on submit.
        </p>
      </div>
      <PartAForm picName={profile.name} picStaffId={profile.staff_id} />
    </div>
  );
}
