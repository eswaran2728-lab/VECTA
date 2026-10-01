import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let title: string | undefined;
  try {
    const body = (await req.json()) as { title?: unknown };
    if (typeof body?.title === "string") title = body.title;
  } catch {
    // fallthrough to validation below
  }
  if (!title || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("rename_wois_conversation_secure", {
    p_conversation_id: id,
    p_title: title,
  });

  if (error || data !== true) {
    return NextResponse.json({ error: "Conversation not found or not owned by caller." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("delete_wois_conversation_secure", {
    p_conversation_id: id,
  });

  if (error || data !== true) {
    return NextResponse.json({ error: "Conversation not found or not owned by caller." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
