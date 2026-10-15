import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { VendorSignatureDeps } from "./vendor-signature";

/** Real clients for the vendor signature workflow: uploads use the caller's session; removal and reconciliation use the service role. */
export async function vendorSignatureDeps(): Promise<VendorSignatureDeps> {
  const user = await createClient();
  const admin = createAdminClient();
  const adminAny = admin as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> } } };
    rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: { name: string }[] | null; error: unknown }>;
  };
  return {
    upload: async (path, bytes, contentType) => {
      const { error } = await user.storage.from("signatures").upload(path, bytes, { contentType, upsert: false });
      return { error };
    },
    removeAsService: async (paths) => {
      const { error } = await admin.storage.from("signatures").remove(paths);
      return { error };
    },
    isReferenced: async (path) => {
      const { data, error } = await adminAny.from("caterlink_vendor_checkpoints").select("id").eq("signature_url", path).limit(1);
      if (error) return null;
      return (data?.length ?? 0) > 0;
    },
    listOrphans: async (olderThanMinutes) => {
      const { data, error } = await adminAny.rpc("list_orphan_vendor_signatures_secure", { p_older_than_minutes: olderThanMinutes });
      if (error) throw new Error("orphan listing failed");
      return (data ?? []).map((r) => r.name);
    },
    log: (event, detail) => console.error(`[vendor-signature] ${event}`, detail ?? ""),
    randomId: () => crypto.randomUUID(),
  };
}
