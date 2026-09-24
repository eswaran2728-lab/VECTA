import { openDB, type IDBPDatabase } from "idb";
import type { ReportType } from "@/lib/avsec/reference-data";

const DB_NAME = "avsec-ops-offline";
const DB_VERSION = 1;
const STORE = "queue";

// The report types plus the two duty check-in/out actions, plus a standalone
// "attachment" retry item — everything that can be queued offline and replayed later
// shares this one IndexedDB store and sync badge.
export type QueueItemType = ReportType | "offload" | "duty_checkin" | "duty_checkout" | "attachment";

// A compressed image or PDF blob queued alongside an offline report submission. Uploaded
// only after the report itself has synced and returned a real report id — never before.
export interface QueuedAttachment {
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

// Payload shape for a standalone "attachment" queue item — created when a report synced
// successfully but one of its attachment uploads failed, so only the attachment (never
// the already-submitted report) needs to retry.
export interface QueuedAttachmentPayload {
  reportType: ReportType;
  reportId: string;
}

export interface QueuedSubmission {
  localId: string;
  type: QueueItemType;
  payload: unknown;
  attachments?: QueuedAttachment[];
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** The profile.id of whoever queued this item — required so a shared
   *  device never syncs, shows, or deletes one user's queued submission
   *  while a different user is signed in. Items belonging to a signed-out
   *  user stay queued untouched until they sign back in. */
  ownerId: string;
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

export async function enqueueSubmission(
  ownerId: string,
  type: QueueItemType,
  payload: unknown,
  attachments?: QueuedAttachment[],
): Promise<string> {
  const db = await getDb();
  const localId = crypto.randomUUID();
  const record: QueuedSubmission = {
    localId,
    type,
    payload,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    createdAt: new Date().toISOString(),
    attempts: 0,
    ownerId,
  };
  await db.put(STORE, record);
  return localId;
}

/** Only items belonging to `ownerId` — a shared device may have another
 *  user's still-queued items sitting in the same IndexedDB store; those
 *  are never listed, synced, or counted while a different user is signed
 *  in. Legacy pre-scoping records (no ownerId) are treated as belonging
 *  to nobody and are excluded here rather than guessed at. */
export async function listQueuedSubmissions(ownerId: string): Promise<QueuedSubmission[]> {
  try {
    const db = await getDb();
    const all = await db.getAll(STORE);
    return all.filter((item) => item.ownerId === ownerId);
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

export async function queueCount(ownerId: string): Promise<number> {
  return (await listQueuedSubmissions(ownerId)).length;
}
