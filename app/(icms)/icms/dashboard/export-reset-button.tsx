"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";
import { DIRECTION_LABELS, STATUS_LABELS } from "@/lib/icms/constants";
import { formatDateTime } from "@/lib/icms/utils";
import {
  getExportResetBundle,
  resetWeek,
  type ExportBundle,
  type ExportBundleRow,
} from "@/lib/icms/actions/archive";

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

const CHECKPOINT_LABELS: Record<string, string> = {
  INFLIGHT_POST: "In-flight Post",
  AIRPORT_POST: "Airport Post",
  PART_D: "Part D",
};

async function addTransactionDetail(doc: jsPDF, t: ExportBundleRow) {
  doc.addPage();
  doc.setFontSize(12);
  doc.text(`${t.transaction_number} — ${DIRECTION_LABELS[t.direction]}`, 14, 16);
  doc.setFontSize(9);
  doc.text(
    `Vehicle ${t.vehicle_number} · Driver ${t.driver_name} (${t.driver_id}) · Status ${STATUS_LABELS[t.status]}`,
    14,
    22
  );

  const seals = t.seals.map((s) => [s.seal_number, s.seal_color]);
  autoTable(doc, {
    startY: 28,
    head: [["Seal Number", "Colour Applied (Part A)"]],
    body: seals.length > 0 ? seals : [["—", "—"]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [212, 175, 55] },
  });

  const verifications = t.seal_verifications.map((v) => [
    CHECKPOINT_LABELS[v.checkpoint] ?? v.checkpoint,
    v.entered_seal_number,
    v.observed_seal_color ?? "—",
    v.matched ? "Match" : "Mismatch",
  ]);
  if (verifications.length > 0) {
    autoTable(doc, {
      head: [["Checkpoint", "Entered Seal", "Observed Colour", "Result"]],
      body: verifications,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [212, 175, 55] },
    });
  }

  const parts: { label: string; officer: string; staffId: string; when: string; sigUrl: string | null }[] = [];
  if (t.part_a) {
    parts.push({
      label: "Part A — Warehouse PIC",
      officer: t.part_a.pic_name,
      staffId: t.part_a.pic_staff_id,
      when: formatDateTime(t.part_a.completed_at),
      sigUrl: t.part_a.signature_signed_url,
    });
  }
  if (t.part_b) {
    parts.push({
      label: "Part B — In-flight Post AVSEC",
      officer: t.part_b.avsec_name,
      staffId: t.part_b.avsec_staff_id,
      when: formatDateTime(t.part_b.completed_at),
      sigUrl: t.part_b.signature_signed_url,
    });
  }
  if (t.part_c) {
    parts.push({
      label: "Part C — Airport Post AVSEC",
      officer: t.part_c.avsec_name,
      staffId: t.part_c.avsec_staff_id,
      when: formatDateTime(t.part_c.completed_at),
      sigUrl: t.part_c.signature_signed_url,
    });
  }
  if (t.part_d) {
    parts.push({
      label: "Part D — Receiver",
      officer: t.part_d.receiver_name,
      staffId: t.part_d.receiver_staff_id,
      when: formatDateTime(t.part_d.completed_at),
      sigUrl: t.part_d.signature_signed_url,
    });
  } else if (t.part_d_skipped) {
    parts.push({
      label: "Part D — Skipped",
      officer: "—",
      staffId: "—",
      when: t.part_d_skip_reason ?? "No reason recorded",
      sigUrl: null,
    });
  }

  autoTable(doc, {
    head: [["Checkpoint", "Officer", "Staff ID", "Completed"]],
    body: parts.map((p) => [p.label, p.officer, p.staffId, p.when]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [238, 46, 36] },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  for (const part of parts) {
    if (!part.sigUrl) continue;
    const dataUrl = await urlToDataUrl(part.sigUrl);
    if (!dataUrl) continue;
    if (y > 250) {
      doc.addPage();
      y = 16;
    }
    doc.setFontSize(8);
    doc.text(part.label, 14, y);
    try {
      doc.addImage(dataUrl, "PNG", 14, y + 2, 50, 22);
      y += 28;
    } catch {
      // unsupported format — skip
    }
  }
}

async function buildExportPdf(bundle: ExportBundle): Promise<jsPDF> {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text("ICMS Weekly Export & Archive", 14, 18);
  doc.setFontSize(9);
  doc.text(
    `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`,
    14,
    24
  );
  doc.text(`${bundle.rows.length} transaction(s), all checkpoints A–D`, 14, 30);

  autoTable(doc, {
    startY: 36,
    head: [["Transaction", "Direction", "Vehicle", "Driver", "Status", "Created"]],
    body: bundle.rows.map((t) => [
      t.transaction_number,
      DIRECTION_LABELS[t.direction],
      t.vehicle_number,
      `${t.driver_name} (${t.driver_id})`,
      STATUS_LABELS[t.status],
      formatDateTime(t.created_at),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [238, 46, 36] },
  });

  for (const t of bundle.rows) {
    await addTransactionDetail(doc, t);
  }

  return doc;
}

type Step = "idle" | "loading" | "confirm" | "archiving" | "done" | "empty";

export function ExportResetButton() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);

  const startExport = async () => {
    setError(null);
    setStep("loading");
    const result = await getExportResetBundle();
    if (result.rows.length === 0) {
      setStep("empty");
      return;
    }
    setBundle(result);
    setStep("confirm");
  };

  const confirmExport = async () => {
    if (!bundle) return;
    setStep("archiving");
    try {
      const doc = await buildExportPdf(bundle);
      const from = bundle.oldest ? bundle.oldest.slice(0, 10) : "";
      const to = bundle.newest ? bundle.newest.slice(0, 10) : "";
      doc.save(`icms-export-reset-${from}-to-${to}.pdf`);

      const result = await resetWeek();
      if (result.error) {
        setError(result.error);
        setStep("confirm");
        return;
      }
      setArchivedCount(result.archivedCount);
      setStep("done");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
      setStep("confirm");
    }
  };

  const close = () => {
    setStep("idle");
    setBundle(null);
    setError(null);
    setArchivedCount(null);
  };

  const from = bundle?.oldest ? bundle.oldest.slice(0, 10) : "";
  const to = bundle?.newest ? bundle.newest.slice(0, 10) : "";

  return (
    <>
      <Button variant="outline" onClick={() => void startExport()} disabled={step === "loading"}>
        {step === "loading" ? "Preparing…" : "Export & Reset Week"}
      </Button>

      {step === "empty" ? (
        <Overlay onClose={close}>
          <p className="text-sm">No pending transactions to export — everything is already archived.</p>
          <Button className="mt-4" onClick={close}>
            Close
          </Button>
        </Overlay>
      ) : null}

      {step === "confirm" || step === "archiving" ? (
        <Overlay onClose={step === "archiving" ? undefined : close}>
          <p className="text-sm">
            This will export all transactions from <strong>{from}</strong> to <strong>{to}</strong> as
            PDF and archive them. Checkpoint users will see a clean dashboard afterward. Continue?
          </p>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={step === "archiving"}>
              Cancel
            </Button>
            <Button onClick={() => void confirmExport()} disabled={step === "archiving"}>
              {step === "archiving" ? "Building PDF & archiving…" : "Confirm"}
            </Button>
          </div>
        </Overlay>
      ) : null}

      {step === "done" ? (
        <Overlay onClose={close}>
          <p className="text-sm">
            Exported and archived {archivedCount ?? 0} transaction(s). Checkpoint dashboards are now
            clean — the full record remains in the Archive.
          </p>
          <Button className="mt-4" onClick={close}>
            Done
          </Button>
        </Overlay>
      ) : null}
    </>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardContent className="pt-6">{children}</CardContent>
      </Card>
    </div>
  );
}
