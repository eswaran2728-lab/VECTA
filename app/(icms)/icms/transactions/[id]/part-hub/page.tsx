import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/icms/auth";

export const metadata: Metadata = { title: "Hub receipt" };
export const dynamic = "force-dynamic";

/**
 * The Hub delivery confirmation is the destination receipt: confirm_caterlink_destination_receipt_secure() records the same hub
 * checkpoint (caterlink_checkpoint_hub), completes the movement, audits it and notifies the sender, and /avsec/caterlink/receipt lists
 * HUB-route movements for the destination station. This legacy step therefore has no page of its own; the receipt screen decides access
 * from the station capability table (a caller without it is returned to their dashboard).
 */
export default async function HubStepRedirect() {
  await requireProfile();
  redirect("/avsec/caterlink/receipt");
}
