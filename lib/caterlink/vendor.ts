import type { SupabaseClient } from "@supabase/supabase-js";

export type VendorDeliveryStatus = "CREATED" | "SECURITY_VERIFIED" | "COMPLETED" | "ESCALATED";

export interface VendorDelivery {
  id: string;
  delivery_number: string;
  aoc_id: string;
  station_id: string;
  vendor_user_id: string;
  status: VendorDeliveryStatus;
  driver_name: string;
  driver_nric: string;
  vehicle_registration_no: string;
  seal_number: string;
  supplies_description: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface VendorCheckpoint {
  id: string;
  delivery_id: string;
  stage: "A" | "B" | "C";
  actor_name: string;
  actor_staff_id: string;
  signature_url: string;
  result: "PASS" | "ESCALATE";
  remarks: string | null;
  escalation_reason: string | null;
  observed: Record<string, string> | null;
  completed_at: string;
}

export const VENDOR_DELIVERY_STATUS_LABELS: Record<VendorDeliveryStatus, string> = {
  CREATED: "Created — awaiting security check",
  SECURITY_VERIFIED: "Security check passed — awaiting your confirmation",
  COMPLETED: "Completed",
  ESCALATED: "Escalated by security",
};

export const VENDOR_DELIVERY_STATUS_COLORS: Record<VendorDeliveryStatus, string> = {
  CREATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  SECURITY_VERIFIED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  ESCALATED: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
};

/** Delivery stations accept vendor deliveries only where scanning is enabled (the approved PEN/JHB scope). */
export const VENDOR_DELIVERY_STATIONS = ["PEN", "JHB"] as const;

// The generated Database types do not describe these tables yet; reads go through RLS, so the typed
// surface is kept deliberately small and local.
type AnyClient = SupabaseClient<any, "public", any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function loadVendorDelivery(
  supabase: AnyClient,
  id: string
): Promise<{ delivery: VendorDelivery | null; checkpoints: VendorCheckpoint[] }> {
  const { data: delivery } = await supabase
    .from("caterlink_vendor_deliveries")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!delivery) return { delivery: null, checkpoints: [] };
  const { data: checkpoints } = await supabase
    .from("caterlink_vendor_checkpoints")
    .select("*")
    .eq("delivery_id", id)
    .order("completed_at", { ascending: true });
  return {
    delivery: delivery as VendorDelivery,
    checkpoints: (checkpoints ?? []) as VendorCheckpoint[],
  };
}

/** RPC call for functions the generated Database types do not describe yet. */
export function callCaterlinkRpc(supabase: unknown, fn: string, args: Record<string, unknown>) {
  return (supabase as AnyClient).rpc(fn, args);
}
