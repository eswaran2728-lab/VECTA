import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  completePartB,
  completePartC,
  completePartD,
  reportIncident,
} from "@/lib/icms/actions/transactions";

export const dynamic = "force-dynamic";

const ACTIONS = {
  part_b: completePartB,
  part_c: completePartC,
  part_d: completePartD,
  incident: reportIncident,
} as const;

function isNextRedirect(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}

/**
 * Replays a submission queued offline. Runs the exact same server action the
 * online path uses, so every rule (role, workflow order, seal verification,
 * RLS, DB triggers) applies identically. A success redirect from the action
 * signals the item was accepted; a returned error is a conflict for the
 * device's resolution UI.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: { kind?: string; payload?: Record<string, string> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const action = ACTIONS[body.kind as keyof typeof ACTIONS];
  if (!action || typeof body.payload !== "object" || body.payload === null) {
    return NextResponse.json({ error: "Unknown sync kind." }, { status: 400 });
  }

  const formData = new FormData();
  for (const [key, value] of Object.entries(body.payload)) {
    formData.set(key, value);
  }

  try {
    const result = await action({ error: null }, formData);
    if (result?.error) {
      // Conflict (e.g. status already advanced) — surface for resolution.
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isNextRedirect(e)) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Sync failed unexpectedly." }, { status: 500 });
  }
}
