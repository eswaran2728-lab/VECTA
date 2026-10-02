import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server/Storage boundary abstraction (Phase 13 correction).
 *
 * Mirrors the already-working, already-production SAT combined-report
 * pattern (lib/phase8/sat.ts) exactly: the server generates the storage
 * path, uploads with the service-role client, and only records the path
 * in a metadata RPC after a successful upload -- the client never
 * supplies a storage path. This interface exists so that pattern can be
 * exercised by a local, in-memory fake in tests (no PGlite/native
 * Postgres instance has real Supabase Storage), while production code
 * uses the real adapter unchanged.
 *
 * Real managed Supabase Storage behavior (actual bucket privacy
 * enforcement, signed-URL expiry, MIME/size enforcement at the storage
 * layer) is NOT proven by any test using the fake adapter -- that remains
 * a staging-only verification, same as every other Storage domain in this
 * repository (see docs/phase13/storage-matrix.md).
 */
export interface StorageUploadResult {
  ok: boolean;
  error?: string;
}

export interface StorageSignedUrlResult {
  url: string | null;
  error?: string;
}

export interface StorageAdapter {
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<StorageUploadResult>;
  remove(bucket: string, path: string): Promise<void>;
  createSignedUrl(bucket: string, path: string, ttlSeconds: number): Promise<StorageSignedUrlResult>;
  exists(bucket: string, path: string): Promise<boolean>;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  async upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<StorageUploadResult> {
    const admin = createAdminClient();
    const { error } = await admin.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async remove(bucket: string, path: string): Promise<void> {
    const admin = createAdminClient();
    await admin.storage.from(bucket).remove([path]);
  }

  async createSignedUrl(bucket: string, path: string, ttlSeconds: number): Promise<StorageSignedUrlResult> {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(path, ttlSeconds);
    return { url: data?.signedUrl ?? null, error: error?.message };
  }

  async exists(bucket: string, path: string): Promise<boolean> {
    const admin = createAdminClient();
    const dir = path.split("/").slice(0, -1).join("/");
    const name = path.split("/").at(-1) ?? path;
    const { data } = await admin.storage.from(bucket).list(dir, { search: name });
    return Boolean(data?.some((f) => f.name === name));
  }
}

/**
 * In-memory fake, test-only. Reproduces the real adapter's
 * `upsert: false` semantics (a second upload to the same bucket+path
 * fails, proving concurrency-safe duplicate prevention logic at the
 * application layer without a real database/storage round trip), and a
 * signed URL only resolves for a path that was actually uploaded (never
 * a caller-supplied path that was never written).
 */
export class FakeStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, Uint8Array>();
  public uploadCallCount = 0;

  private key(bucket: string, path: string): string {
    return `${bucket}::${path}`;
  }

  async upload(bucket: string, path: string, bytes: Uint8Array, _contentType: string): Promise<StorageUploadResult> {
    this.uploadCallCount += 1;
    const key = this.key(bucket, path);
    if (this.objects.has(key)) {
      return { ok: false, error: "The resource already exists" };
    }
    this.objects.set(key, bytes);
    return { ok: true };
  }

  async remove(bucket: string, path: string): Promise<void> {
    this.objects.delete(this.key(bucket, path));
  }

  async createSignedUrl(bucket: string, path: string, ttlSeconds: number): Promise<StorageSignedUrlResult> {
    const key = this.key(bucket, path);
    if (!this.objects.has(key)) {
      return { url: null, error: "Object not found" };
    }
    return { url: `fake-signed://${key}?ttl=${ttlSeconds}&t=${Date.now()}` };
  }

  async exists(bucket: string, path: string): Promise<boolean> {
    return this.objects.has(this.key(bucket, path));
  }
}
