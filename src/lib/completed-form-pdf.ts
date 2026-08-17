import "server-only";

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl, uploadPdfBuffer } from "@/lib/storage";
import { stepsFor, type CheckpointPart } from "@/lib/workflow";
import {
  CARGO_TYPE_LABELS,
  DELIVERY_LOCATION_LABELS,
  DIRECTION_LABELS,
  HUB_DESTINATION_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import type {
  CateringCompany,
  PartA,
  PartBC,
  PartD,
  PartHub,
  PartRedq,
  Seal,
  SealVerification,
  Transaction,
} from "@/lib/database.types";

async function signatureDataUrl(path: string | null): Promise<string | null> {
  const url = await signedUrl("signatures", path);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function sealVerificationLines(
  checkpoint: "INFLIGHT_POST" | "AIRPORT_POST" | "PART_D" | "REDQ",
  verifications: SealVerification[]
): string[] {
  return verifications
    .filter((v) => v.checkpoint === checkpoint)
    .map(
      (v) =>
        `${v.entered_seal_number} (${v.observed_seal_color ?? "—"}) — ${v.matched ? "Match" : "Mismatch"}`
    );
}

function addSignatureBlock(
  doc: jsPDF,
  y: number,
  label: string,
  dataUrl: string | null
): number {
  doc.setFontSize(8);
  doc.text(`${label} signature:`, 14, y);
  if (dataUrl) {
    try {
      doc.addImage(dataUrl, "PNG", 14, y + 2, 45, 20);
      return y + 26;
    } catch {
      return y + 6;
    }
  }
  return y + 6;
}

/**
 * Builds the completed-form PDF for a finished transaction, mirroring the
 * amended IFCSF (AA/SEC/F/010 Rev.01) layout: header + cargo checklist +
 * supplies breakdown from Part A, then every checkpoint in the same order
 * the paper form covers for that direction/route (stepsFor() is the
 * single source of truth for that ordering — Part Hub/REDQ get their own
 * rendering branches since their record shape differs from PartBC/PartD).
 */
function buildPdf(
  transaction: Transaction & { catering_companies: Pick<CateringCompany, "name"> | null },
  partA: PartA | null,
  parts: Partial<Record<CheckpointPart, PartBC | PartD | PartHub | PartRedq | null>>,
  seals: Seal[],
  verifications: SealVerification[],
  signatures: Partial<Record<"part_a" | CheckpointPart, string | null>>
): jsPDF {
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text("In-flight Catering Security Form (IFCSF)", 14, 16);
  doc.setFontSize(9);
  doc.text("AA/SEC/F/010 Rev. 01", 14, 22);
  doc.text(
    `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`,
    14,
    27
  );

  autoTable(doc, {
    startY: 32,
    head: [["Transaction", "Direction", "Route", "Station", "Vehicle", "Driver", "Status"]],
    body: [
      [
        transaction.transaction_number,
        DIRECTION_LABELS[transaction.direction],
        transaction.route === "HUB" && transaction.hub_destination
          ? `Hub — ${HUB_DESTINATION_LABELS[transaction.hub_destination]}`
          : transaction.route === "REDQ"
            ? "REDQ → FOB"
            : "Aircraft",
        transaction.station ?? "—",
        transaction.vehicle_number,
        `${transaction.driver_name} (${transaction.driver_id})`,
        transaction.part_d_skipped ? "Completed — Part D skipped" : "Completed",
      ],
    ],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [238, 46, 36] },
  });

  const cargoLine =
    transaction.cargo_types.length > 0
      ? transaction.cargo_types.map((c) => CARGO_TYPE_LABELS[c]).join(", ")
      : "—";
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  doc.setFontSize(9);
  doc.text(`Cargo Type: ${cargoLine}`, 14, y);
  y += 8;

  // Part A — supplies breakdown + certifying PIC.
  doc.setFontSize(11);
  doc.text("PART A — Warehouse / FOB", 14, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    head: [["Total Supplies", "Carts", "SMU", "Pallets", "Boxes", "Oven Rack"]],
    body: [
      [
        transaction.supplies_total ?? "—",
        transaction.supplies_carts ?? "—",
        transaction.supplies_smu ?? "—",
        transaction.supplies_pallets ?? "—",
        transaction.supplies_boxes ?? "—",
        transaction.supplies_oven_racks ?? "—",
      ].map(String),
    ],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [212, 175, 55] },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;

  const sealsBody =
    seals.length > 0
      ? seals.map((s) => [
          s.seal_number,
          s.seal_type,
          s.seal_color,
          s.superseded_at ? `Superseded ${formatDateTime(s.superseded_at)}` : "Active",
        ])
      : [["—", "—", "—", "—"]];
  autoTable(doc, {
    startY: y,
    head: [["Seal Number", "Type", "Colour Applied", "Status"]],
    body: sealsBody,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [212, 175, 55] },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;

  doc.setFontSize(8);
  doc.text(
    `Name: ${partA?.pic_name ?? "—"}    ID No: ${partA?.pic_staff_id ?? "—"}    Date/Time: ${formatDateTime(partA?.completed_at ?? null)}`,
    14,
    y
  );
  y += 4;
  if (transaction.escort_officer_name) {
    doc.text(
      `Escort Officer: ${transaction.escort_officer_name} (${transaction.escort_officer_staff_id ?? "—"})    Escort Vehicle: ${transaction.escort_vehicle_number ?? "—"}`,
      14,
      y
    );
    y += 4;
  }
  y = addSignatureBlock(doc, y, "PIC", signatures.part_a ?? null);
  if (y > 250) {
    doc.addPage();
    y = 16;
  }

  // Every checkpoint in the direction/route's actual sequence — the same
  // order the paper form uses. Section headings come straight from each
  // step's own label, so Hub/REDQ headings never need special-casing.
  stepsFor(transaction.direction, transaction.route).forEach((step) => {
    if (y > 230) {
      doc.addPage();
      y = 16;
    }
    doc.setFontSize(11);
    doc.text(step.label.toUpperCase(), 14, y);
    y += 4;

    if (step.part === "part_hub") {
      const record = parts.part_hub as PartHub | null;
      if (!record) {
        doc.setFontSize(8);
        doc.text("Not completed.", 14, y);
        y += 8;
        return;
      }
      const rows: [string, string][] = [
        ["Confirmed Destination", HUB_DESTINATION_LABELS[record.confirmed_destination]],
        ["Hub AVSEC", `${record.hub_avsec_name} (${record.hub_avsec_staff_id})`],
        ["Date/Time", formatDateTime(record.completed_at)],
      ];
      if (record.remarks) rows.push(["Remarks", record.remarks]);
      autoTable(doc, {
        startY: y,
        body: rows,
        styles: { fontSize: 8 },
        columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
      y = addSignatureBlock(doc, y, "Hub AVSEC", signatures.part_hub ?? null);
      return;
    }

    if (step.part === "part_redq") {
      const record = parts.part_redq as PartRedq | null;
      if (!record) {
        doc.setFontSize(8);
        doc.text("Not completed.", 14, y);
        y += 8;
        return;
      }
      // Full seal chain — both the closed-out old seal and the newly
      // applied one, per the audit-trail requirement for this step.
      const oldSeal = seals.find((s) => s.id === record.old_seal_id);
      const newSeal = seals.find((s) => s.id === record.new_seal_id);
      const rows: [string, string][] = [
        [
          "Old Seal (closed out)",
          oldSeal
            ? `${oldSeal.seal_number} (${oldSeal.seal_color}) — superseded ${formatDateTime(oldSeal.superseded_at)}`
            : "—",
        ],
        ["New Seal (applied)", newSeal ? `${newSeal.seal_number} (${newSeal.seal_color})` : "—"],
        ["REDQ AVSEC", `${record.redq_avsec_name} (${record.redq_avsec_staff_id})`],
        ["Date/Time", formatDateTime(record.completed_at)],
      ];
      const sealLines = sealVerificationLines("REDQ", verifications);
      if (sealLines.length > 0) rows.push(["Old Seal Verification", sealLines.join("; ")]);
      if (record.remarks) rows.push(["Remarks", record.remarks]);
      autoTable(doc, {
        startY: y,
        body: rows,
        styles: { fontSize: 8 },
        columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
      y = addSignatureBlock(doc, y, "REDQ AVSEC", signatures.part_redq ?? null);
      return;
    }

    const record = parts[step.part] as PartBC | PartD | null | undefined;
    if (!record) {
      doc.setFontSize(8);
      doc.text(
        step.part === "part_d" && transaction.part_d_skipped
          ? `Skipped — ${transaction.part_d_skip_reason ?? "no reason recorded"}`
          : "Not completed.",
        14,
        y
      );
      y += 8;
      return;
    }

    const isPartD = step.part === "part_d";
    const officerName = isPartD ? (record as PartD).receiver_name : (record as PartBC).avsec_name;
    const officerId = isPartD
      ? (record as PartD).receiver_staff_id
      : (record as PartBC).avsec_staff_id;
    const rows: [string, string][] = isPartD
      ? [
          ["Delivery Location", DELIVERY_LOCATION_LABELS[(record as PartD).delivery_location]],
          ...((record as PartD).aircraft_identifier
            ? ([["Aircraft Identifier", (record as PartD).aircraft_identifier as string]] as [
                string,
                string,
              ][])
            : []),
        ]
      : [
          ["Vehicle Reg. No", (record as PartBC).observed_vehicle_number ?? "—"],
          [
            "Driver Name & ID",
            `${(record as PartBC).observed_driver_name ?? "—"} / ${(record as PartBC).observed_driver_id ?? "—"}`,
          ],
        ];
    rows.push(["ASO Name", officerName], ["ASO ID No", officerId], ["Result", record.result]);
    if (record.escalation_reason) rows.push(["Escalation Reason", record.escalation_reason]);
    if (record.remarks) rows.push(["Remarks", record.remarks]);
    rows.push([
      "Date/Time",
      `${record.checkpoint_date} ${record.checkpoint_time}`,
    ]);

    const checkpointKey =
      step.part === "part_b" ? "INFLIGHT_POST" : step.part === "part_c" ? "AIRPORT_POST" : "PART_D";
    const sealLines = sealVerificationLines(checkpointKey, verifications);
    if (sealLines.length > 0) rows.push(["Seal Verification", sealLines.join("; ")]);

    autoTable(doc, {
      startY: y,
      body: rows,
      styles: { fontSize: 8 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
    y = addSignatureBlock(doc, y, "ASO", signatures[step.part] ?? null);
  });

  return doc;
}

/**
 * Auto-runs right after a transaction reaches COMPLETED (Part D pass, Part
 * D skip, Part Hub, or the inbound final Part B) so the finished
 * IFCSF-style record exists for the admin to pull up without anyone
 * opening the transaction page first. Best-effort: a PDF failure never
 * blocks the checkpoint that just completed — it's an audit artifact, not
 * part of the workflow gate.
 */
export async function generateCompletedFormPdf(transactionId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: txRow } = await supabase
      .from("transactions")
      .select("*, catering_companies(name)")
      .eq("id", transactionId)
      .single();
    if (!txRow) return;
    const transaction = txRow as unknown as Transaction & {
      catering_companies: Pick<CateringCompany, "name"> | null;
    };
    if (transaction.status !== "COMPLETED") return;

    const [partARes, partBRes, partCRes, partDRes, partHubRes, partRedqRes, sealsRes] =
      await Promise.all([
        supabase.from("part_a").select("*").eq("transaction_id", transactionId).maybeSingle(),
        supabase.from("part_b").select("*").eq("transaction_id", transactionId).maybeSingle(),
        supabase.from("part_c").select("*").eq("transaction_id", transactionId).maybeSingle(),
        supabase.from("part_d").select("*").eq("transaction_id", transactionId).maybeSingle(),
        supabase.from("part_hub").select("*").eq("transaction_id", transactionId).maybeSingle(),
        supabase.from("part_redq").select("*").eq("transaction_id", transactionId).maybeSingle(),
        // No superseded_at filter — the PDF shows the full seal chain,
        // including any seal a REDQ re-seal closed out.
        supabase.from("seals").select("*").eq("transaction_id", transactionId),
      ]);
    const partA = partARes.data as PartA | null;
    const partB = partBRes.data as PartBC | null;
    const partC = partCRes.data as PartBC | null;
    const partD = partDRes.data as PartD | null;
    const partHub = partHubRes.data as PartHub | null;
    const partRedq = partRedqRes.data as PartRedq | null;
    const seals = (sealsRes.data ?? []) as Seal[];

    const sealIds = seals.map((s) => s.id);
    const verifications = sealIds.length
      ? ((await supabase.from("seal_verifications").select("*").in("seal_id", sealIds)).data as
          | SealVerification[]
          | null) ?? []
      : [];

    const [sigA, sigB, sigC, sigD, sigHub, sigRedq] = await Promise.all([
      signatureDataUrl(partA?.signature_url ?? null),
      signatureDataUrl(partB?.signature_url ?? null),
      signatureDataUrl(partC?.signature_url ?? null),
      signatureDataUrl(partD?.signature_url ?? null),
      signatureDataUrl(partHub?.signature_url ?? null),
      signatureDataUrl(partRedq?.signature_url ?? null),
    ]);

    const doc = buildPdf(
      transaction,
      partA,
      { part_b: partB, part_c: partC, part_d: partD, part_hub: partHub, part_redq: partRedq },
      seals,
      verifications,
      {
        part_a: sigA,
        part_b: sigB,
        part_c: sigC,
        part_d: sigD,
        part_hub: sigHub,
        part_redq: sigRedq,
      }
    );
    const bytes = Buffer.from(doc.output("arraybuffer"));

    const path = await uploadPdfBuffer("completed-forms", bytes, transaction.transaction_number);

    // No RLS UPDATE policy exists for regular authenticated users on
    // transactions (writes go through triggers/RPCs) — use the service
    // role, same pattern as user management elsewhere in this codebase.
    const admin = createAdminClient();
    const { error: linkError } = await admin
      .from("transactions")
      .update({ completed_form_url: path })
      .eq("id", transactionId);
    if (linkError) {
      console.error(
        "[completed-form-pdf] PDF uploaded to",
        path,
        "but linking it to the transaction failed:",
        linkError.message
      );
    }
  } catch (e) {
    console.error("[completed-form-pdf] generation failed for", transactionId, e);
  }
}
