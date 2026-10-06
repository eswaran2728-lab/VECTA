import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const timestamp = new Date().toISOString();
  let dbConnected = false;

  try {
    // Health checks run without a user session. Use the server-only admin client so
    // RLS on profiles cannot turn a healthy database into a false degraded result.
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("profiles")
      .select("id")
      .limit(1)
      .maybeSingle();

    dbConnected = !error;
  } catch {
    dbConnected = false;
  }

  const isHealthy = dbConnected;
  const status = isHealthy ? "ok" : "degraded";
  const statusCode = isHealthy ? 200 : 503;

  return NextResponse.json(
    {
      status,
      timestamp,
      version: "1.0.0",
      database: dbConnected,
    },
    {
      status: statusCode,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Content-Type": "application/json",
      },
    }
  );
}
