import { createClient } from "@/lib/supabase/server";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";

/** Final-receipt capability for display (nav): a station operator whose single assigned station holds the receipt capability. */
export async function getCanConfirmCaterLinkReceipt(access: CanonicalAccess): Promise<boolean> {
  if (!access.hasAssignment || access.isSuperAdmin || !access.stationCode) return false;
  if (!access.roleCodes.some((c) => c === "aso" || c === "so" || c === "sso")) return false;
  const supabase = await createClient();
  const { data } = await supabase.rpc("can_user_confirm_caterlink_receipt", { p_station_code: access.stationCode });
  return data === true;
}
