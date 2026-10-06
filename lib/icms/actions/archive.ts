"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/icms/storage";
import type {
  PartA,
  PartBC,
  PartD,
  Seal,
  SealVerification,
  Transaction,
} from "@/lib/icms/database.types";

export interface ExportPartA extends PartA {
  signature_signed_url: string | null;
}
export interface ExportPartBC extends PartBC {
  signature_signed_url: string | null;
}
export interface ExportPartD extends PartD {
  signature_signed_url: string | null;
}

export interface ExportBundleRow extends Transaction {
  seals: Seal[];
  seal_verifications: SealVerification[];
  part_a: ExportPartA | null;
  part_b: ExportPartBC | null;
  part_c: ExportPartBC | null;
  part_d: ExportPartD | null;
}

export interface ExportBundle {
  rows: ExportBundleRow[];
  oldest: string | null;
  newest: string | null;
}

/**
 * Admin-only: full detail (parts A-D, seals, seal verifications, signed
 * signature URLs) for every not-yet-archived transaction. Used to build the
 * weekly export PDF client-side before the transactions are archived.
 */
export async function getExportResetBundle(): Promise<ExportBundle> {
  await requireRole(["supervisor"]);
  const supabase = await createClient();

  const { data: transactions } = await supabase
    .from("transactions")
    .select("*")
    .eq("archived", false)
    .order("created_at", { ascending: true });

  const txRows = (transactions ?? []) as Transaction[];
  if (txRows.length === 0) return { rows: [], oldest: null, newest: null };

  const ids = txRows.map((t) => t.id);

  // Canonical Phase 9 checkpoint tables; Part B and Part C share part_b_c (checkpoint_stage B / C).
  const [sealsRes, partARes, partBCRes, partDRes] = await Promise.all([
    supabase.from("seals").select("*").in("transaction_id", ids),
    supabase.from("caterlink_checkpoint_part_a" as never).select("*").in("transaction_id", ids),
    supabase.from("part_b_c" as never).select("*").in("transaction_id", ids),
    supabase.from("caterlink_checkpoint_part_d" as never).select("*").in("transaction_id", ids),
  ]);
  const partBCRows = (partBCRes.data ?? []) as unknown as (PartBC & { checkpoint_stage: "B" | "C" })[];
  const partBRes = { data: partBCRows.filter((p) => p.checkpoint_stage === "B") };
  const partCRes = { data: partBCRows.filter((p) => p.checkpoint_stage === "C") };

  const seals = (sealsRes.data ?? []) as Seal[];
  const sealIds = seals.map((s) => s.id);
  const { data: verifications } = sealIds.length
    ? await supabase.from("seal_verifications").select("*").in("seal_id", sealIds)
    : { data: [] as SealVerification[] };

  const sealsByTx = new Map<string, Seal[]>();
  for (const seal of seals) {
    sealsByTx.set(seal.transaction_id, [...(sealsByTx.get(seal.transaction_id) ?? []), seal]);
  }
  const sealTxById = new Map(seals.map((s) => [s.id, s.transaction_id]));
  const verificationsByTx = new Map<string, SealVerification[]>();
  for (const v of (verifications ?? []) as SealVerification[]) {
    const txId = sealTxById.get(v.seal_id);
    if (!txId) continue;
    verificationsByTx.set(txId, [...(verificationsByTx.get(txId) ?? []), v]);
  }

  const partAByTx = new Map(((partARes.data ?? []) as PartA[]).map((p) => [p.transaction_id, p]));
  const partBByTx = new Map(((partBRes.data ?? []) as PartBC[]).map((p) => [p.transaction_id, p]));
  const partCByTx = new Map(((partCRes.data ?? []) as PartBC[]).map((p) => [p.transaction_id, p]));
  const partDByTx = new Map(((partDRes.data ?? []) as PartD[]).map((p) => [p.transaction_id, p]));

  const rows: ExportBundleRow[] = await Promise.all(
    txRows.map(async (t) => {
      const partA = partAByTx.get(t.id) ?? null;
      const partB = partBByTx.get(t.id) ?? null;
      const partC = partCByTx.get(t.id) ?? null;
      const partD = partDByTx.get(t.id) ?? null;
      const [aUrl, bUrl, cUrl, dUrl] = await Promise.all([
        signedUrl("signatures", partA?.signature_url ?? null),
        signedUrl("signatures", partB?.signature_url ?? null),
        signedUrl("signatures", partC?.signature_url ?? null),
        signedUrl("signatures", partD?.signature_url ?? null),
      ]);
      return {
        ...t,
        seals: sealsByTx.get(t.id) ?? [],
        seal_verifications: verificationsByTx.get(t.id) ?? [],
        part_a: partA ? { ...partA, signature_signed_url: aUrl } : null,
        part_b: partB ? { ...partB, signature_signed_url: bUrl } : null,
        part_c: partC ? { ...partC, signature_signed_url: cUrl } : null,
        part_d: partD ? { ...partD, signature_signed_url: dUrl } : null,
      };
    })
  );

  return {
    rows,
    oldest: txRows[0].created_at,
    newest: txRows[txRows.length - 1].created_at,
  };
}

export interface ResetWeekState {
  error: string | null;
  archivedCount: number | null;
}

/**
 * Admin-only: archives every not-yet-archived transaction (flag only,
 * nothing is ever deleted) so checkpoint dashboards reset to a clean
 * slate. Call only after the export PDF has already been downloaded.
 */
export async function resetWeek(): Promise<ResetWeekState> {
  await requireRole(["supervisor", "management"]);
  const supabase = await createClient();

  // Canonical path: archive each open transaction through the audited per-transaction RPC (nothing is
  // deleted; the snapshot is kept in caterlink_archives). The legacy archive_all_pending RPC does not
  // exist in the canonical model.
  const { data: open } = await supabase.from("transactions").select("id").eq("archived", false).limit(2000);
  let archived = 0;
  for (const row of (open ?? []) as { id: string }[]) {
    const { error: archiveError } = await supabase.rpc("archive_caterlink_transaction_secure", {
      p_transaction_id: row.id,
      p_reason: "Weekly export and reset",
    });
    if (archiveError) return { error: archiveError.message, archivedCount: archived };
    archived += 1;
  }

  revalidatePath("/icms/dashboard");
  revalidatePath("/icms/transactions");
  revalidatePath("/icms/incidents");
  revalidatePath("/icms/admin/archive");
  return { error: null, archivedCount: archived };
}

/**
 * Phase 9: Secure single-transaction archive using the audited RPC.
 */
export async function archiveSingleTransaction(
  transactionId: string,
  reason?: string
): Promise<{ error: string | null; success: boolean }> {
  await requireRole(["supervisor", "management"]);
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_caterlink_transaction_secure", {
    p_transaction_id: transactionId,
    p_reason: reason ?? null,
  });
  if (error) return { error: error.message, success: false };
  revalidatePath("/icms/transactions");
  revalidatePath("/icms/admin/archive");
  return { error: null, success: true };
}
