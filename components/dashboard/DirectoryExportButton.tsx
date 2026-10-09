"use client";

import { useState } from "react";
import { exportEntityUserDirectory } from "@/lib/avsec/admin/entity-registrations";

const COLUMNS = ["staff_no", "name", "role_code", "department_code", "unit_code", "hub_code", "station_code", "team_name"] as const;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Own-entity directory export for MAA/AAX Admin. The server action calls export_entity_user_directory(), which re-checks the
 * caller is an approved admin of THIS entity, audits the export and omits protected roles; nothing is authorized here.
 */
export function DirectoryExportButton({ entityCode }: { entityCode: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await exportEntityUserDirectory(entityCode);
      if (!result.ok) {
        setMessage(result.error ?? "The export was refused.");
        return;
      }
      const lines = [COLUMNS.join(","), ...result.data.map((row) => COLUMNS.map((c) => csvCell((row as Record<string, unknown>)[c])).join(","))];
      const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${entityCode.toLowerCase()}-staff-directory.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${result.data.length} ${entityCode} staff.`);
    } catch {
      setMessage("The export could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <button type="button" onClick={run} disabled={busy} className="btn-secondary min-h-[44px] px-4 text-xs">
        {busy ? "Exporting…" : `Export ${entityCode} directory (CSV)`}
      </button>
      {message ? (
        <p className="font-mono text-[11px] text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
