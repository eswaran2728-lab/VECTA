import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ProfileStatus } from "@/lib/avsec/reference-data";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const systemType = String(body.system_type ?? "avsec");
    const name = String(body.name ?? "").trim();
    const staffId = String(body.staff_id ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();
    const password = String(body.password ?? "");

    // AVSEC Specific fields
    const avsecRole = String(body.avsec_role ?? "SO").toUpperCase();
    const opsGroup = String(body.ops_group ?? "operation_avsec");
    const team = String(body.team ?? "ALPHA").toUpperCase();
    const station = String(body.station ?? "KUL - MAA");

    // Driver / CaterLink Specific fields
    const driverType = String(body.driver_type ?? "driver_vendor");
    const vendorCompany = String(body.vendor_company ?? "").trim();
    const vehiclePlate = String(body.vehicle_plate ?? "").trim().toUpperCase();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!name || !staffId || !email) {
      return NextResponse.json(
        { error: "Full Name, Staff/Driver ID, and Email are required." },
        { status: 400 }
      );
    }
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Please provide a valid email address." },
        { status: 400 }
      );
    }
    if (!phone) {
      return NextResponse.json(
        { error: "Phone number is required for verification." },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    // Security hardening: Public self-registration only permits operational shift ranks
    const allowedOperationalRoles = ["DSE", "SO", "ASO"];
    const safeAvsecRole = allowedOperationalRoles.includes(avsecRole) ? avsecRole : "SO";

    const supabase = await createClient();

    // Explicit duplicate check in database profiles & users
    const [profileMatch, userMatch] = await Promise.all([
      supabase.from("profiles").select("id").eq("email", email).maybeSingle(),
      supabase.from("users").select("id").eq("email", email).maybeSingle(),
    ]);

    if (profileMatch.data || userMatch.data) {
      return NextResponse.json(
        { error: "This email is already registered — contact your admin or try signing in instead." },
        { status: 400 }
      );
    }

    const unifiedRole =
      systemType === "caterlink"
        ? "vendor"
        : (safeAvsecRole.toLowerCase() as "so" | "aso" | "dse" | "vendor");

    const { data: created, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          full_name: name,
          staff_id: staffId,
          phone,
          system_type: systemType,
          role: systemType === "caterlink" ? "vendor" : safeAvsecRole,
          unified_role: unifiedRole,
          ops_group: opsGroup,
          team,
          station,
          driver_type: driverType,
          vendor_company: vendorCompany,
          vehicle_plate: vehiclePlate,
        },
      },
    });

    if (
      authError ||
      !created.user ||
      (created.user.identities && created.user.identities.length === 0)
    ) {
      const errMsg = authError?.message?.toLowerCase() ?? "";
      if (
        errMsg.includes("already registered") ||
        errMsg.includes("already in use") ||
        errMsg.includes("user already") ||
        (created.user && created.user.identities && created.user.identities.length === 0)
      ) {
        return NextResponse.json(
          { error: "This email is already registered — contact your admin or try signing in instead." },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: authError?.message ?? "Could not create account." },
        { status: 400 }
      );
    }

    if (systemType === "avsec") {
      // Insert into AVSEC profiles table with 'pending' status
      const { error: profileError } = await supabase.from("profiles").upsert(
        {
          id: created.user.id,
          email,
          name,
          staff_no: staffId,
          role: (avsecRole ?? "ASO") as "ASO" | "SO" | "DSE" | "ADMIN" | "ENFORCEMENT" | "MANAGEMENT",
          unified_role: unifiedRole,
          ops_group: opsGroup,
          team,
          station,
          status: "pending" as ProfileStatus,
        },
        { onConflict: "id" }
      );

      if (profileError) {
        console.error("[api/auth/register] AVSEC profile insert note:", profileError.message);
      }
    } else {
      // Insert into ICMS users table with 'pending' status
      const { error: userError } = await supabase.from("users").upsert(
        {
          id: created.user.id,
          name,
          staff_id: staffId,
          email,
          role: "vendor",
          unified_role: "vendor",
          status: "pending",
        },
        { onConflict: "id" }
      );

      if (userError) {
        console.error("[api/auth/register] Driver user insert note:", userError.message);
      }
    }

    return NextResponse.json({
      success: `Registration submitted successfully for ${
        systemType === "avsec" ? "VECTA (AirAsia AVSEC)" : "CATERLINK (Catering Movement)"
      }! Your account is now pending approval from an Administrator. You will be able to sign in once approved.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to register account." },
      { status: 500 }
    );
  }
}
