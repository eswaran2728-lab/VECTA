import { NextResponse } from "next/server";
import { getFeedbackThreadMessages } from "@/lib/avsec/feedback/queries";
import { getCurrentProfile } from "@/lib/avsec/auth";

export async function GET(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  const params = await paramsPromise;
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const messages = await getFeedbackThreadMessages(params.id);
  return NextResponse.json({ messages });
}
