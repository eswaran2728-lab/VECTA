"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeSec013Report } from "@/lib/phase8/profiling-actions";

export function ProfilingAcknowledgeControl({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button
        type="button"
        className="btn-secondary !text-success hover:!bg-success/20 px-3 py-1 text-xs font-mono font-bold"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await acknowledgeSec013Report(reportId);
            if (!res.ok) {
              setError(res.error ?? "Failed to acknowledge.");
              return;
            }
            router.refresh();
          })
        }
      >
        {isPending ? "Acknowledging…" : "✓ Acknowledge SEC013"}
      </button>
    </div>
  );
}
