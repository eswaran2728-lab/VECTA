import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const timestamp = new Date().toISOString();
  let dbConnected = false;

  try {
    const supabase = await createClient();
    // Fast, lightweight query using limit(1) to test database connectivity without heavy reads
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
