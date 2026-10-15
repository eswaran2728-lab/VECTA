import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { activeAnnouncementsFor, managementAnnouncementsFrom } from "../lib/avsec/announcements/canonical.ts";

type Call = { rpc: string[]; from: string[] };
function client(rpc: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const calls: Call = { rpc: [], from: [] };
  const supabase = {
    rpc: async (name: string) => { calls.rpc.push(name); return { data: rpc[name]?.data ?? null, error: rpc[name]?.error ?? null }; },
    from: (t: string) => { calls.from.push(t); throw new Error(`legacy table ${t} must not be queried`); },
  };
  return { supabase: supabase as never, calls };
}
const ITEM = { id: "a1", title: "T", body: "B", scope: "aoc", aoc_id: null, aoc_code: "MY", category: "operations", priority: "urgent", status: "published", is_pinned: false, requires_acknowledgement: true, acknowledged: false, acknowledged_at: null, attachment_count: 0, published_at: "2026-10-01T00:00:00Z", expires_at: null, created_at: "2026-10-01T00:00:00Z" };

test("a successful secure RPC that returns zero rows yields zero announcements and never touches a legacy table", async () => {
  const { supabase, calls } = client({ get_visible_announcements_secure: { data: [] } });
  assert.deepEqual(await activeAnnouncementsFor(supabase), []);
  assert.deepEqual(calls.from, []);
});

test("a secure RPC error fails closed (no announcements) and never falls back to a legacy table", async () => {
  const { supabase, calls } = client({ get_visible_announcements_secure: { error: { message: "not eligible" } } });
  assert.deepEqual(await activeAnnouncementsFor(supabase), []);
  assert.deepEqual(calls.from, []);
  const thrower = { rpc: async () => { throw new Error("network"); }, from: () => { throw new Error("legacy"); } } as never;
  assert.deepEqual(await activeAnnouncementsFor(thrower), []);
});

test("rows from the secure RPC map to the banner shape (urgent => pop-up)", async () => {
  const { supabase } = client({ get_visible_announcements_secure: { data: [ITEM, { ...ITEM, id: "a2", priority: "normal" }] } });
  const out = await activeAnnouncementsFor(supabase);
  assert.equal(out.length, 2);
  assert.equal(out[0].is_pop, true);
  assert.equal(out[1].is_pop, false);
  assert.equal(out[0].acknowledged, false);
});

test("management view is built from the secure manageable list and the secure acknowledgement report only", async () => {
  const report = {
    announcement_id: "a1", title: "T", scope: "aoc", aoc_code: "MY", requires_acknowledgement: true, total_eligible: 3, total_acknowledged: 1, pending_count: 2, compliance_percentage: 33,
    acknowledged_staff: [{ profile_id: "p1", name: "Ana", staff_no: "S1", department: "operation", station: "KUL - MAA", acknowledged_at: "2026-10-02T00:00:00Z" }],
    pending_staff: [{ profile_id: "p2", name: "Bo", staff_no: "S2", department: "operation", station: "PEN" }, { profile_id: "p3", name: "Cy", staff_no: "S3", department: null, station: null }],
  };
  const { supabase, calls } = client({ list_manageable_announcements_secure: { data: [ITEM] }, get_announcement_acknowledgement_report_secure: { data: report } });
  const out = await managementAnnouncementsFrom(supabase);
  assert.deepEqual(calls.from, []);
  assert.deepEqual(calls.rpc.sort(), ["get_announcement_acknowledgement_report_secure", "list_manageable_announcements_secure"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].total_target_users, 3);
  assert.equal(out[0].acknowledged_count, 1);
  assert.equal(out[0].acknowledgements[0].user_id, "p1");
  assert.deepEqual(out[0].pending_users.map((p) => p.user_id), ["p2", "p3"]);
});

test("a failing list or report degrades to an empty view / empty lists, never to a table query", async () => {
  const a = client({ list_manageable_announcements_secure: { error: { message: "denied" } } });
  assert.deepEqual(await managementAnnouncementsFrom(a.supabase), []);
  const b = client({ list_manageable_announcements_secure: { data: [ITEM] }, get_announcement_acknowledgement_report_secure: { error: { message: "denied" } } });
  const out = await managementAnnouncementsFrom(b.supabase);
  assert.equal(out.length, 1);
  assert.equal(out[0].acknowledgements.length + out[0].pending_users.length, 0);
  assert.deepEqual(b.calls.from, []);
});

test("source: no legacy announcement table access and no direct-insert creation fallback remain", () => {
  for (const f of ["lib/avsec/announcements/queries.ts", "lib/avsec/announcements/actions.ts", "lib/avsec/announcements/canonical.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\.from\(\s*["'](announcements|announcement_targets|announcement_acknowledgements)["']/, `${f} must not query a legacy announcement table`);
  }
  const actions = fs.readFileSync("lib/avsec/announcements/actions.ts", "utf8");
  assert.doesNotMatch(actions, /export async function createAnnouncement\(/, "the unused legacy creation wrapper (with its direct-insert fallback) is removed");
  const queries = fs.readFileSync("lib/avsec/announcements/queries.ts", "utf8");
  assert.doesNotMatch(queries, /Falling back to table query|legacy schemas/);
});
