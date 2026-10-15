import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SignatureDeps } from "./signature-storage";

/** Real clients for the signature workflow: uploads use the caller's session; removal, reference checks and reconciliation use the service role. */
export async function signatureDeps(): Promise<SignatureDeps> {
  const user = await createClient();
  const admin = createAdminClient();
  const adminRpc = admin as unknown as {
    rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
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
      const { data, error } = await adminRpc.rpc("caterlink_signature_referenced", { p_name: path });
      if (error || typeof data !== "boolean") return null;
      return data;
    },
    listOrphans: async (olderThanMinutes) => {
      const { data, error } = await adminRpc.rpc("list_orphan_signatures_secure", { p_older_than_minutes: olderThanMinutes });
      if (error) throw new Error("orphan listing failed");
      return ((data as { name: string }[] | null) ?? []).map((r) => r.name);
    },
    log: (event, detail) => console.error(`[signature] ${event}`, detail ?? ""),
    randomId: () => crypto.randomUUID(),
  };
}
