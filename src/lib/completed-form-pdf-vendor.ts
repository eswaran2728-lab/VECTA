import "server-only";

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrl, uploadPdfBuffer } from "@/lib/storage";
import type { VendorPartA, VendorPartB, VendorPartC, VendorTransaction } from "@/lib/database.types";

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

function addSignatureBlock(doc: jsPDF, y: number, label: string, dataUrl: string | null): number {
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
 * Builds the completed-form PDF for a finished vendor transaction,
 * mirroring the AA/SEC/F/019 "Vendors Supplies Security Form" layout:
 * Part A (Vendor), Part B (AirAsia Security), Part C (Warehouse — dual
 * certification, both signatures side by side).
 */
function buildPdf(
  transaction: VendorTransaction,
  partA: VendorPartA | null,
  partB: VendorPartB | null,
  partC: VendorPartC | null,
  signatures: { part_a: string | null; part_b: string | null; warehouse: string | null; vendor: string | null }
): jsPDF {
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text("Vendors Supplies Security Form", 14, 16);
  doc.setFontSize(9);
  doc.text("AA/SEC/F/019 Rev. 01", 14, 22);
  doc.text(
    `Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`,
    14,
    27
  );

  autoTable(doc, {
    startY: 32,
    head: [["Transaction", "Status"]],
    body: [[transaction.transaction_number, "Completed"]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [238, 46, 36] },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  // Part A — Vendor.
  doc.setFontSize(11);
  doc.text("PART A — VENDOR", 14, y);
  y += 4;
  autoTable(doc, {
    startY: y,
    body: [
      ["Driver Name", partA?.driver_name ?? "—"],
      ["NRIC Number", partA?.nric_number ?? "—"],
      ["Seal Number", partA?.seal_number ?? "—"],
      ["Date/Time", partA ? new Date(partA.completed_at).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" }) : "—"],
    ],
    styles: { fontSize: 8 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
  y = addSignatureBlock(doc, y, "Vendor Driver", signatures.part_a);
  if (y > 250) {
    doc.addPage();
    y = 16;
  }

  // Part B — AirAsia Security.
  doc.setFontSize(11);
  doc.text("PART B — AIRASIA SECURITY (POST 2)", 14, y);
  y += 4;
  if (!partB) {
    doc.setFontSize(8);
    doc.text("Not completed.", 14, y);
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      body: [
        ["Vehicle Reg. No", partB.vehicle_registration_no],
        ["Driver Name & NRIC", `${partB.driver_name} / ${partB.driver_nric}`],
        ["Seal Number", partB.seal_number],
        ["ASO Name", partB.avsec_name],
        ["ASO ID No", partB.avsec_staff_id],
        ...(partB.remarks ? [["Remarks", partB.remarks]] : []),
        ["Date/Time", new Date(partB.completed_at).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })],
      ] as [string, string][],
      styles: { fontSize: 8 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
    y = addSignatureBlock(doc, y, "ASO", signatures.part_b);
  }
  if (y > 220) {
    doc.addPage();
    y = 16;
  }

  // Part C — Warehouse (In-Flight), dual certification.
  doc.setFontSize(11);
  doc.text("PART C — WAREHOUSE (IN-FLIGHT), DUAL CERTIFICATION", 14, y);
  y += 4;
  doc.setFontSize(7);
  doc.text(
    "I hereby declare that the information given above is true and accurate to the best of my knowledge.",
    14,
    y
  );
  y += 5;
  if (!partC) {
    doc.setFontSize(8);
    doc.text("Not completed.", 14, y);
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      body: [
        ["Warehouse PIC", partC.warehouse_pic_name ?? "—"],
        [
          "Warehouse Signed At",
          partC.warehouse_signed_at
            ? new Date(partC.warehouse_signed_at).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })
            : "—",
        ],
        ["Vendor Driver", partC.vendor_driver_name ?? "—"],
        [
          "Vendor Signed At",
          partC.vendor_signed_at
            ? new Date(partC.vendor_signed_at).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })
            : "—",
        ],
      ],
      styles: { fontSize: 8 },
      columnStyles: { 0: { fontStyle: "bold", cellWidth: 45 } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
    const warehouseEndY = addSignatureBlock(doc, y, "Warehouse PIC", signatures.warehouse);
    // Vendor signature block placed alongside, in the second half of the
    // page width, so both certifications read side by side per the form.
    doc.setFontSize(8);
    doc.text("Vendor Driver signature:", 110, y);
    if (signatures.vendor) {
      try {
        doc.addImage(signatures.vendor, "PNG", 110, y + 2, 45, 20);
      } catch {
        // signature image failed to embed; text label above still shows
      }
    }
    y = Math.max(warehouseEndY, y + 26);
  }

  return doc;
}

/**
 * Auto-runs right after a vendor transaction reaches COMPLETED (both Part
 * C signatures captured). Best-effort: a PDF failure never blocks the
 * checkpoint that just completed — it's an audit artifact, not part of
 * the workflow gate. Mirrors generateCompletedFormPdf() in
 * completed-form-pdf.ts.
 */
export async function generateVendorCompletedFormPdf(transactionId: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: txRow } = await supabase
      .from("vendor_transactions")
      .select("*")
      .eq("id", transactionId)
      .single();
    if (!txRow) return;
    const transaction = txRow as VendorTransaction;
    if (transaction.status !== "COMPLETED") return;

    const [partARes, partBRes, partCRes] = await Promise.all([
      supabase.from("vendor_part_a").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("vendor_part_b").select("*").eq("transaction_id", transactionId).maybeSingle(),
      supabase.from("vendor_part_c").select("*").eq("transaction_id", transactionId).maybeSingle(),
    ]);
    const partA = partARes.data as VendorPartA | null;
    const partB = partBRes.data as VendorPartB | null;
    const partC = partCRes.data as VendorPartC | null;

    const [sigA, sigB, sigWarehouse, sigVendor] = await Promise.all([
      signatureDataUrl(partA?.signature_url ?? null),
      signatureDataUrl(partB?.signature_url ?? null),
      signatureDataUrl(partC?.warehouse_signature_url ?? null),
      signatureDataUrl(partC?.vendor_signature_url ?? null),
    ]);

    const doc = buildPdf(transaction, partA, partB, partC, {
      part_a: sigA,
      part_b: sigB,
      warehouse: sigWarehouse,
      vendor: sigVendor,
    });
    const bytes = Buffer.from(doc.output("arraybuffer"));

    const path = await uploadPdfBuffer("completed-forms", bytes, transaction.transaction_number);

    // No RLS UPDATE policy exists for regular authenticated users on
    // vendor_transactions (writes go through triggers) — use the service
    // role, same pattern as the catering completed-form generator.
    const admin = createAdminClient();
    const { error: linkError } = await admin
      .from("vendor_transactions")
      .update({ completed_form_url: path })
      .eq("id", transactionId);
    if (linkError) {
      console.error(
        "[completed-form-pdf-vendor] PDF uploaded to",
        path,
        "but linking it to the transaction failed:",
        linkError.message
      );
    }
  } catch (e) {
    console.error("[completed-form-pdf-vendor] generation failed for", transactionId, e);
  }
}
