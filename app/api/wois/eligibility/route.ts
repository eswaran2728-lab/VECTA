import { NextResponse } from "next/server";
import { getWoisEligibility } from "@/lib/wois/eligibility";
import { getWoisSuggestedActions } from "@/lib/wois/suggestions";
import { getCurrentProfile } from "@/lib/avsec/auth";

export async function GET() {
  const eligibility = await getWoisEligibility();
  if (!eligibility.eligible) {
    return NextResponse.json({ ...eligibility, suggestedActions: [] });
  }

  const profile = await getCurrentProfile();
  const suggestedActions = getWoisSuggestedActions(profile?.role ?? null);

  return NextResponse.json({ ...eligibility, suggestedActions });
}
