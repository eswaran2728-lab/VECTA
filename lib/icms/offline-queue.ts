"use client";

/**
 * IndexedDB queue for checkpoint/incident submissions made while offline.
 * Items are replayed through POST /api/sync by <PwaProvider> on reconnect.
 */

export type QueuedKind = "part_b" | "part_c" | "part_d" | "incident";

export interface QueuedItem {
  id: string;
  kind: QueuedKind;
  /** Flattened form fields captured at submit time. */
  payload: Record<string, string>;
  createdAt: string;
  /** Set when the server rejected the replay (e.g. status conflict). */
  error?: string;
}

const DB_NAME = "cscs-offline";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function queueSubmission(
  kind: QueuedKind,
  payload: Record<string, string>
): Promise<QueuedItem> {
  const item: QueuedItem = {
    id: crypto.randomUUID(),
    kind,
    payload,
    createdAt: new Date().toISOString(),
  };
  await tx("readwrite", (s) => s.put(item));
  window.dispatchEvent(new Event("cscs-queue-changed"));
  return item;
}

export async function listQueue(): Promise<QueuedItem[]> {
  return tx("readonly", (s) => s.getAll() as IDBRequest<QueuedItem[]>);
}

export async function removeQueued(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  window.dispatchEvent(new Event("cscs-queue-changed"));
}

export async function markQueuedError(item: QueuedItem, error: string): Promise<void> {
  await tx("readwrite", (s) => s.put({ ...item, error }));
  window.dispatchEvent(new Event("cscs-queue-changed"));
}

/** Capture a form's fields as a plain object for queueing. */
export function formDataToPayload(form: HTMLFormElement): Record<string, string> {
  const payload: Record<string, string> = {};
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") payload[key] = value;
  });
  return payload;
}
