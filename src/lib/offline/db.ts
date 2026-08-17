import { openDB, type IDBPDatabase } from "idb";
import type { ReportType } from "@/lib/reference-data";

const DB_NAME = "avsec-ops-offline";
const DB_VERSION = 1;
const STORE = "queue";

// The report types plus the two duty check-in/out actions — everything that can be
// queued offline and replayed later shares this one IndexedDB store and sync badge.
export type QueueItemType = ReportType | "duty_checkin" | "duty_checkout";

export interface QueuedSubmission {
  localId: string;
  type: QueueItemType;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "localId" });
        }
      },
    });
  }
  return dbPromise;
}

export async function enqueueSubmission(type: QueueItemType, payload: unknown): Promise<string> {
  const db = await getDb();
  const localId = crypto.randomUUID();
  const record: QueuedSubmission = {
    localId,
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await db.put(STORE, record);
  return localId;
}

export async function listQueuedSubmissions(): Promise<QueuedSubmission[]> {
  try {
    const db = await getDb();
    return await db.getAll(STORE);
  } catch {
    return [];
  }
}

export async function removeQueuedSubmission(localId: string) {
  const db = await getDb();
  await db.delete(STORE, localId);
}

export async function updateQueuedSubmission(record: QueuedSubmission) {
  const db = await getDb();
  await db.put(STORE, record);
}

export async function queueCount(): Promise<number> {
  return (await listQueuedSubmissions()).length;
}
