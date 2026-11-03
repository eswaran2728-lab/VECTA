import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDraftResume, shouldClearDraftsAfter } from "../lib/avsec/reports/draft-resume.ts";

const d = (v: string) => ({ data: { remark: v }, savedAt: "2026-11-03T10:00:00.000Z" });

test("no drafts: start blank", () => assert.deepEqual(decideDraftResume(null, null), { kind: "none" }));

test("only one side has a draft: resume it without asking", () => {
  assert.equal(decideDraftResume(d("a"), null).kind, "local");
  assert.equal(decideDraftResume(null, d("a")).kind, "server");
});

test("identical content on both sides is not a conflict", () => {
  assert.deepEqual(decideDraftResume(d("same"), { ...d("same"), savedAt: "2026-11-03T11:00:00.000Z" }), { kind: "local" });
});

test("different content on both sides is a conflict: the user chooses, both timestamps are shown, nothing is silently overwritten", () => {
  const local = { data: { remark: "phone" }, savedAt: "2026-11-03T10:00:00.000Z" };
  const server = { data: { remark: "laptop" }, savedAt: "2026-11-03T12:00:00.000Z" };
  const r = decideDraftResume(local, server);
  assert.equal(r.kind, "conflict");
  if (r.kind === "conflict") {
    assert.equal(r.localSavedAt, local.savedAt);
    assert.equal(r.serverSavedAt, server.savedAt);
    assert.equal(r.newer, "server");
  }
  const r2 = decideDraftResume({ ...local, savedAt: "2026-11-03T13:00:00.000Z" }, server);
  assert.equal(r2.kind === "conflict" && r2.newer, "local");
  const r3 = decideDraftResume({ ...local, savedAt: "" }, server);
  assert.equal(r3.kind === "conflict" && r3.newer, "unknown", "a local draft with no recorded time never claims to be newer");
});

test("drafts are cleared only after a confirmed submission, never when queued, failed or needing recovery", () => {
  assert.equal(shouldClearDraftsAfter("submitted"), true);
  assert.equal(shouldClearDraftsAfter("queued"), false);
  assert.equal(shouldClearDraftsAfter("failed"), false);
  assert.equal(shouldClearDraftsAfter("recovery"), false);
});
