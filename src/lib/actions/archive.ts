"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signedUrl } from "@/lib/storage";
import type {
  PartA,
  PartBC,
  PartD,
  Seal,
  SealVerification,
  Transaction,
} from "@/lib/database.types";

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

  const [sealsRes, partARes, partBRes, partCRes, partDRes] = await Promise.all([
    supabase.from("seals").select("*").in("transaction_id", ids),
    supabase.from("part_a").select("*").in("transaction_id", ids),
    supabase.from("part_b").select("*").in("transaction_id", ids),
    supabase.from("part_c").select("*").in("transaction_id", ids),
    supabase.from("part_d").select("*").in("transaction_id", ids),
  ]);

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
  await requireRole(["supervisor"]);
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("archive_all_pending", {});
  if (error) return { error: error.message, archivedCount: null };

  revalidatePath("/dashboard");
  revalidatePath("/transactions");
  revalidatePath("/incidents");
  revalidatePath("/admin/archive");
  return { error: null, archivedCount: (data as number) ?? 0 };
}
