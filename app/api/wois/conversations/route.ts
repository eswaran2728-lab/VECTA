import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWoisEligibility } from "@/lib/wois/eligibility";

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const eligibility = await getWoisEligibility();
  if (!eligibility.eligible) {
    return NextResponse.json({ error: "WOIS AI is not available for your account." }, { status: 403 });
  }

  let title = "New Chat";
  try {
    const body = (await req.json()) as { title?: unknown };
    if (typeof body?.title === "string" && body.title.trim().length > 0) {
      title = body.title;
    }
  } catch {
    // No body is fine -- default title applies.
  }

  const { data: id, error } = await supabase.rpc("create_wois_conversation_secure", { p_title: title });
  if (error || !id) {
    return NextResponse.json({ error: "Could not create conversation." }, { status: 403 });
  }

  return NextResponse.json({ conversationId: id });
}
