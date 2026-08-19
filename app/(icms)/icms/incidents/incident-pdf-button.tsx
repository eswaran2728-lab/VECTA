"use client";

import { useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import type { Incident } from "@/lib/icms/database.types";

interface IncidentPdfButtonProps {
  incident: Incident;
  transactionNumber: string;
  vehicleNumber: string;
  /** Signed URLs of evidence photos (short-lived). */
  photoUrls: string[];
}

async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Full per-incident report: details, timeline, resolution, photo evidence. */
export function IncidentPdfButton({
  incident,
  transactionNumber,
  vehicleNumber,
  photoUrls,
}: IncidentPdfButtonProps) {
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.text(`ICMS Incident Report — ${transactionNumber}`, 14, 16);
      doc.setFontSize(9);
      doc.text(
        `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`,
        14,
        22
      );

      autoTable(doc, {
        startY: 28,
        head: [["Field", "Value"]],
        body: [
          ["Incident Type", INCIDENT_TYPE_LABELS[incident.incident_type]],
          ["Status", INCIDENT_STATUS_LABELS[incident.status]],
          ["Transaction", transactionNumber],
          ["Vehicle", vehicleNumber],
          ["Reported By", incident.reported_by],
          ["Description", incident.description],
        ],
        styles: { fontSize: 9, cellWidth: "wrap" },
        columnStyles: { 1: { cellWidth: 130 } },
        headStyles: { fillColor: [153, 27, 27] },
      });

      const timeline: string[][] = [["Reported", formatDateTime(incident.created_at)]];
      if (incident.resolved_at) {
        timeline.push([
          incident.status === "CLOSED" ? "Closed" : "Resolved",
          formatDateTime(incident.resolved_at),
        ]);
      }
      autoTable(doc, {
        head: [["Timeline Event", "When (MYT)"]],
        body: timeline,
        headStyles: { fillColor: [30, 64, 175] },
      });

      if (incident.resolution_notes) {
        autoTable(doc, {
          head: [["Resolution Notes"]],
          body: [[incident.resolution_notes]],
          headStyles: { fillColor: [5, 150, 105] },
        });
      }

      let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
      for (const url of photoUrls.slice(0, 5)) {
        const dataUrl = await urlToDataUrl(url);
        if (!dataUrl) continue;
        if (y > 200) {
          doc.addPage();
          y = 16;
        }
        try {
          doc.addImage(dataUrl, "PNG", 14, y, 80, 60);
          y += 66;
        } catch {
          // unsupported format — skip
        }
      }

      doc.save(`cscs-incident-${transactionNumber}-${incident.id.slice(0, 8)}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void generate()}
      disabled={busy}
      className="text-xs text-primary underline disabled:opacity-50"
    >
      {busy ? "Building…" : "PDF"}
    </button>
  );
}
