import type { Metadata } from "next";
import { requireProfile } from "@/lib/icms/auth";
import { ModuleNotActivated } from "@/components/icms/ModuleNotActivated";

export const metadata: Metadata = { title: "Part C checkpoint" };
export const dynamic = "force-dynamic";

// BLOCKED: this step was written against the legacy ICMS workflow tables (part_a..part_d, part_hub,
// part_redq, incidents), which do not exist in the canonical Phase 9 CaterLink model. The canonical
// model has no checkpoint-write RPC for it yet, so recording it here would fail. See
// docs/dashboard-review/caterlink-legacy-to-canonical-mapping.md. Scanning permission itself
// (can_user_scan_caterlink: PEN/JHB) is unchanged.
export default async function BlockedCheckpointPage() {
  await requireProfile();
  return (
    <ModuleNotActivated
      title="Part C checkpoint"
      detail="Recording this step is not available yet: it has no canonical CaterLink workflow function on this environment."
    />
  );
}
