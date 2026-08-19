"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import type { Json } from "@/lib/supabase/database.types";
import type { GeoPolygon } from "./geofence";

function backTo(station: string) {
  return `/avsec/admin/zones?station=${encodeURIComponent(station)}`;
}

export async function upsertZone(formData: FormData) {
  const admin = await requireRole(ADMIN_ROLES);

  const id = String(formData.get("id") || "").trim();
  const station = String(formData.get("station") || "").trim();
  const code = String(formData.get("code") || "")
    .trim()
    .toUpperCase();
  const name = String(formData.get("name") || "").trim();
  const geometryRaw = String(formData.get("geometry_json") || "");

  if (!station || !code || !name) {
    redirect(backTo(station) + "&error=" + encodeURIComponent("Station, code, and name are required."));
  }

  let geometry: { polygon: GeoPolygon | null; center_lat: number | null; center_lng: number | null; radius_m: number | null };
  try {
    geometry = JSON.parse(geometryRaw);
  } catch {
    geometry = { polygon: null, center_lat: null, center_lng: null, radius_m: null };
  }
  if (!geometry.polygon || geometry.center_lat === null || geometry.center_lng === null) {
    redirect(backTo(station) + "&error=" + encodeURIComponent("Draw at least a 3-point polygon on the map."));
  }

  const supabase = await createClient();
  const { error } = await supabase.from("duty_zones").upsert(
    {
      ...(id ? { id } : {}),
      station,
      code,
      name,
      polygon: geometry.polygon as unknown as Json,
      center_lat: geometry.center_lat,
      center_lng: geometry.center_lng,
      radius_m: geometry.radius_m ?? undefined,
      created_by: admin.id,
    },
    { onConflict: id ? "id" : "station,code" },
  );

  if (error) {
    redirect(backTo(station) + "&error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/avsec/admin/zones");
  redirect(backTo(station));
}

// Zones may be referenced by duty_records, so this deactivates rather than deletes —
// deactivated zones drop off the check-in roster picker but keep historical records intact.
export async function toggleZoneActive(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const id = String(formData.get("id") || "");
  const station = String(formData.get("station") || "");
  const active = formData.get("active") === "true";
  if (!id) return;

  const supabase = await createClient();
  await supabase.from("duty_zones").update({ active: !active }).eq("id", id);

  revalidatePath("/avsec/admin/zones");
  redirect(backTo(station));
}
