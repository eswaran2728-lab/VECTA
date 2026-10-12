import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";

/**
 * Retired. The legacy Anonymous Feedback module (feedback_threads / feedback_messages and the public.notifications table) was
 * superseded by the Phase 10 anonymous discussion board (see migration 20260929000001) and does not exist in the canonical schema.
 * This route only keeps old bookmarks working: it requires a signed-in approved profile and sends the caller to the Discussion Board.
 */
export default async function RetiredFeedbackPage() {
  await requireProfile();
  redirect("/avsec/discussions");
}
