import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for shared-browser draft/offline-queue isolation
 * (2026-09-24): lib/avsec/offline/useDraftAutosave.ts and
 * lib/avsec/offline/db.ts. Both are "use client" modules that import via
 * the `@/lib/...` path alias (only resolvable inside the Next.js build,
 * not plain Node — same constraint as every other "use client"/"use
 * server" file in this suite), so this mirrors readLocalDraft/
 * clearLocalDraft's exact logic against a real in-memory localStorage
 * stub, rather than importing the module directly.
 */

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const storageInstance = new FakeStorage();
function storage(): FakeStorage {
  return storageInstance;
}

function legacyKey(type: string) {
  return `avsec-ops:draft:${type}`;
}
function scopedKey(userId: string, type: string) {
  return `avsec-ops:draft:${userId}:${type}`;
}

/** Mirrors useDraftAutosave.ts's readLocalDraft() exactly. */
function readLocalDraft<T>(userId: string, type: string): T | null {
  const scoped = storage().getItem(scopedKey(userId, type));
  if (scoped) return JSON.parse(scoped) as T;
  const legacy = storage().getItem(legacyKey(type));
  if (legacy) {
    storage().setItem(scopedKey(userId, type), legacy);
    storage().removeItem(legacyKey(type));
    return JSON.parse(legacy) as T;
  }
  return null;
}

/** Mirrors useDraftAutosave.ts's clearLocalDraft() exactly. */
function clearLocalDraft(userId: string, type: string) {
  storage().removeItem(scopedKey(userId, type));
}

test("REGRESSION: ALPHA's draft is invisible to BRAVO on the same device (scoped keys)", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:user-alpha:sec014", JSON.stringify({ note: "alpha's draft" }));

  const bravoRead = readLocalDraft<{ note: string }>("user-bravo", "sec014");
  assert.equal(bravoRead, null);

  const alphaRead = readLocalDraft<{ note: string }>("user-alpha", "sec014");
  assert.deepEqual(alphaRead, { note: "alpha's draft" });
});

test("REGRESSION: after logout/login as a different account, the previous account's draft is not shown", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:user-alpha:sec016", JSON.stringify({ note: "alpha" }));
  // Simulate the app rendering the form again after user-bravo signs in on
  // the same browser — the component only ever reads with bravo's id now.
  const nextUserRead = readLocalDraft<{ note: string }>("user-bravo", "sec016");
  assert.equal(nextUserRead, null);
});

test("The same user can restore their own draft across a reload", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:user-alpha:sec018", JSON.stringify({ note: "still here" }));
  const read = readLocalDraft<{ note: string }>("user-alpha", "sec018");
  assert.deepEqual(read, { note: "still here" });
});

test("clearLocalDraft only clears the calling user's own scoped draft, never another user's", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:user-alpha:sec029", JSON.stringify({ a: 1 }));
  storage().setItem("avsec-ops:draft:user-bravo:sec029", JSON.stringify({ b: 1 }));

  clearLocalDraft("user-alpha", "sec029");

  assert.equal(readLocalDraft("user-alpha", "sec029"), null);
  assert.deepEqual(readLocalDraft<{ b: number }>("user-bravo", "sec029"), { b: 1 });
});

test("REGRESSION: a legacy unscoped draft (pre-fix) migrates safely into the CURRENT reader's scoped key on first read, then never leaks to a later different user", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:sec033", JSON.stringify({ legacy: true }));

  // First reader after the fix ships claims it.
  const first = readLocalDraft<{ legacy: boolean }>("user-alpha", "sec033");
  assert.deepEqual(first, { legacy: true });

  // The legacy key is gone -- a second, different user reading the same
  // report type afterward gets nothing (no leak), even though the legacy
  // key existed moments ago.
  const second = readLocalDraft("user-bravo", "sec033");
  assert.equal(second, null);

  // The original user can still see it under their own scoped key.
  const again = readLocalDraft<{ legacy: boolean }>("user-alpha", "sec033");
  assert.deepEqual(again, { legacy: true });
});

test("Migration never overwrites a user's own newer scoped draft with a stale legacy one", () => {
  storage().clear();
  storage().setItem("avsec-ops:draft:sec013", JSON.stringify({ legacy: true }));
  storage().setItem("avsec-ops:draft:user-alpha:sec013", JSON.stringify({ current: true }));

  const read = readLocalDraft<{ current?: boolean; legacy?: boolean }>("user-alpha", "sec013");
  assert.deepEqual(read, { current: true });
});

// --- Offline queue (IndexedDB) ownership scoping: db.ts requires a real
// IndexedDB, unavailable under plain Node — this asserts the exported
// function signatures actually require an ownerId (a type/shape check
// that would fail to compile if the scoping were ever silently dropped),
// consistent with this repo's established pattern for browser-only
// modules it cannot fully execute outside a DOM. ---

test("SCOPE: enqueueSubmission/listQueuedSubmissions/queueCount all require an explicit ownerId parameter", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../lib/avsec/offline/db.ts", import.meta.url), "utf8"),
  );
  assert.match(src, /export async function enqueueSubmission\(\s*ownerId: string/);
  assert.match(src, /export async function listQueuedSubmissions\(ownerId: string\)/);
  assert.match(src, /export async function queueCount\(ownerId: string\)/);
  assert.match(src, /return all\.filter\(\(item\) => item\.ownerId === ownerId\)/);
});
