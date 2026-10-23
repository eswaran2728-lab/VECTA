import test from "node:test";
import assert from "node:assert/strict";
import { classify, TABLE_SPECS } from "../scripts/staging/e2e-fixtures.mjs";

test("discovery attributes new checkpoint and seal rows to their new E2E parents", async () => {
  const rows: Record<string, { k: string; parent?: string }[]> = {
    transactions: [{ k: "tx-1" }],
    seals: [{ k: "seal-1", parent: "tx-1" }],
    caterlink_checkpoint_part_a: [{ k: "part-a-1", parent: "tx-1" }],
    caterlink_vendor_deliveries: [{ k: "delivery-1" }],
    caterlink_vendor_checkpoints: [{ k: "vendor-b-1", parent: "delivery-1" }],
  };
  const baseline = { ids: Object.fromEntries(TABLE_SPECS.map(({ t }) => [t, []])), objects: [], refs: [] };
  const q = async (sql: string, params: unknown[] = []) => {
    if (/storage\.objects|caterlink_signature_refs/.test(sql)) return [];
    const table = sql.match(/from public\.([a-z_]+)/)?.[1];
    if (!table) throw new Error(`unexpected query: ${sql}`);
    const all = rows[table] ?? [];
    if (!sql.includes("where")) return all.map(({ k }) => ({ k }));
    const fresh = new Set((params[0] ?? []) as string[]);
    const parents = params[1] ? new Set(params[1] as string[]) : null;
    return all.filter((r) => fresh.has(r.k) && (!parents || parents.has(r.parent ?? ""))).map(({ k }) => ({ k }));
  };
  const result = await classify(q, baseline, {});
  for (const [table, id] of [["transactions", "tx-1"], ["seals", "seal-1"], ["caterlink_checkpoint_part_a", "part-a-1"], ["caterlink_vendor_deliveries", "delivery-1"], ["caterlink_vendor_checkpoints", "vendor-b-1"]]) {
    assert.deepEqual(result.created[table], [id], table);
  }
  assert.deepEqual(result.unclassified, {});
});
