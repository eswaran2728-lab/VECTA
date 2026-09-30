"use client";

import { useState, useTransition } from "react";

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  return lines.join("\n");
}

export function ExportWorkforceButton({
  label,
  action,
}: {
  label: string;
  action: () => Promise<{ ok: boolean; error: string | null; data: Record<string, unknown>[] | null }>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button
        type="button"
        className="btn-secondary w-full text-xs"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await action();
            if (!res.ok || !res.data) {
              setError(res.error ?? "Export failed.");
              return;
            }
            const csv = toCsv(res.data);
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${label.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          })
        }
      >
        {isPending ? "Preparing export…" : `Export ${label} (CSV)`}
      </button>
    </div>
  );
}
