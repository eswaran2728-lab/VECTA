import crypto from "node:crypto";
import { STATIONS } from "@/lib/avsec/reference-data";

/**
 * Public self-registration boundary. The endpoint is unauthenticated and uses the privileged client to create Auth users, so it
 * enforces its own limits: an explicit system-type allowlist, strict field shapes and lengths, an anti-automation check (provider
 * independent, fail-closed when required but not configured), a durable database-backed rate limit keyed by hashes, generic public
 * errors, identical responses for new and already-registered emails, and rollback of the Auth user when the profile write fails.
 * Accounts are always created 'pending' with an operational role only; nothing the caller sends can select a privileged role.
 */
export const REGISTRATION_SUCCESS =
  "Registration received. If your details are valid, your account is now pending approval from an Administrator, and you will be able to sign in once approved.";

const MAX_BODY_BYTES = 8 * 1024;
const OPERATIONAL_ROLES = ["DSE", "SO", "ASO"] as const;
const DRIVER_TYPES = ["driver_ifc", "driver_vendor"] as const;
const IP_LIMIT = { limit: 10, windowSeconds: 3600 };
const EMAIL_LIMIT = { limit: 5, windowSeconds: 3600 };

export interface RegistrationDeps {
  admin: {
    from: (table: string) => {
      select: (cols: string) => { eq: (col: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error?: unknown }> } };
      upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => PromiseLike<{ error: { message?: string } | null }>;
      insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
      delete: () => { eq: (col: string, v: string) => PromiseLike<{ error: { message?: string } | null }> };
    };
    auth: {
      admin: {
        createUser: (a: Record<string, unknown>) => PromiseLike<{ data: { user: { id: string } | null }; error: { message?: string } | null }>;
        deleteUser: (id: string) => PromiseLike<unknown>;
      };
    };
  };
  /** Anti-automation verification (Turnstile or any provider). Called only when verification is required and configured. */
  verify: (token: string | null, ip: string) => Promise<boolean>;
  /** Durable rate limit: 'ok' | 'limited' | 'error' for a hashed key. */
  throttle: (keyHash: string, limit: number, windowSeconds: number) => Promise<"ok" | "limited" | "error">;
  env: { antibotRequired: boolean; antibotConfigured: boolean; /** Trust x-real-ip / x-forwarded-for (only behind a trusted proxy such as Vercel). Default true. */ trustProxyHeaders?: boolean };
  /** Sanitised diagnostics: an event name and optional non-personal detail (never an email, name, address or upstream message). */
  log: (event: string, detail?: Record<string, string | number>) => void;
  /** Optional clock/sleep (tests) and a minimum response time for the account-exists / account-created outcomes (default: none). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minResponseMs?: number;
}

const reply = (status: number, body: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (v: unknown, max: number, { min = 0 }: { min?: number } = {}): string | null => {
  if (v === undefined || v === null) return min === 0 ? "" : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < min || t.length > max || CONTROL.test(t)) return null;
  return t;
};

type Parsed =
  | { ok: false; error: string }
  | {
      ok: true;
      value: {
        systemType: "avsec" | "caterlink"; name: string; staffId: string; email: string; phone: string; password: string;
        role: string; team: string; station: string; driverType: string; vendorCompany: string; vehiclePlate: string;
      };
    };

function parse(body: unknown): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid request." };
  const b = body as Record<string, unknown>;
  const rawType = b.system_type === undefined ? "avsec" : b.system_type;
  if (rawType !== "avsec" && rawType !== "caterlink") return { ok: false, error: "Select a valid system to register for." };
  const name = text(b.name, 100, { min: 1 });
  const staffId = text(b.staff_id, 32, { min: 1 });
  const email = text(b.email, 254, { min: 3 })?.toLowerCase() ?? null;
  const phone = text(b.phone, 32, { min: 1 });
  const password = typeof b.password === "string" ? b.password : null;
  if (!name || !staffId || !email) return { ok: false, error: "Full Name, Staff/Driver ID, and Email are required." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,31}$/.test(staffId)) return { ok: false, error: "Staff/Driver ID contains invalid characters." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Please provide a valid email address." };
  if (!phone || !/^\+?[0-9][0-9 ()\-]{5,31}$/.test(phone)) return { ok: false, error: "A valid phone number is required for verification." };
  if (!password || password.length < 8 || password.length > 128) return { ok: false, error: "Password must be between 8 and 128 characters." };

  let role = "";
  let team = "";
  let station = "";
  let driverType = "";
  let vendorCompany = "";
  let vehiclePlate = "";
  if (rawType === "avsec") {
    role = String(b.avsec_role ?? "SO").toUpperCase();
    if (!(OPERATIONAL_ROLES as readonly string[]).includes(role)) return { ok: false, error: "Select a valid role." };
    const t = text(b.team ?? "ALPHA", 24, { min: 1 })?.toUpperCase() ?? null;
    if (!t || !/^[A-Z0-9][A-Z0-9 _-]{0,23}$/.test(t)) return { ok: false, error: "Select a valid team." };
    team = t;
    station = typeof b.station === "string" ? b.station.trim() : "KUL - MAA";
    if (!(STATIONS as readonly string[]).includes(station)) return { ok: false, error: "Select a valid station." };
  } else {
    driverType = String(b.driver_type ?? "driver_vendor");
    if (!(DRIVER_TYPES as readonly string[]).includes(driverType)) return { ok: false, error: "Select a valid driver type." };
    const vc = text(b.vendor_company, 100);
    const vp = text(b.vehicle_plate, 20)?.toUpperCase() ?? null;
    if (vc === null || vp === null || !/^[A-Z0-9 \-]{0,20}$/.test(vp)) return { ok: false, error: "Check the vendor company and vehicle plate." };
    vendorCompany = vc;
    vehiclePlate = vp;
  }
  return { ok: true, value: { systemType: rawType, name, staffId, email, phone, password, role, team, station, driverType, vendorCompany, vehiclePlate } };
}

function clientAddress(request: Request, trustProxyHeaders: boolean): string {
  if (!trustProxyHeaders) return "unknown";
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

export async function handleRegistration(request: Request, deps: RegistrationDeps): Promise<Response> {
  const clock = deps.now ?? Date.now;
  const t0 = clock();
  // Existing and new emails get the same answer; padding both to one floor keeps their response TIMES equal whenever the real work fits
  // inside it (if the Auth call is slower than the floor the difference is not hidden; see the audit document).
  const padded = async (res: Response): Promise<Response> => {
    const left = (deps.minResponseMs ?? 0) - (clock() - t0);
    if (left > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(left);
    return res;
  };
  const unavailable = () => reply(503, { error: "Registration is temporarily unavailable." });
  try {
    const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { error: "Request too large." });
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: "Request too large." });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "Invalid request." }); }

    const ip = clientAddress(request, deps.env.trustProxyHeaders !== false);
    const ipGate = await deps.throttle(sha256(`registration:ip:${ip}`), IP_LIMIT.limit, IP_LIMIT.windowSeconds);
    if (ipGate === "error") { deps.log("registration_throttle_unavailable"); return unavailable(); }
    if (ipGate === "limited") return reply(429, { error: "Too many attempts. Please try again later." });

    // Cheap validation first: a mistyped field must not spend a single-use anti-automation token.
    const parsed = parse(body);
    if (!parsed.ok) return reply(400, { error: parsed.error });
    const v = parsed.value;

    // Anti-automation: when required and not configured the endpoint is closed (never silently open).
    if (deps.env.antibotRequired) {
      if (!deps.env.antibotConfigured) { deps.log("registration_antibot_not_configured"); return unavailable(); }
      const candidate = body && typeof body === "object" ? (body as Record<string, unknown>).verification_token : null;
      const token = typeof candidate === "string" ? candidate.slice(0, 2048) : null;
      let human = false;
      try { human = await deps.verify(token, ip); } catch { deps.log("registration_antibot_error"); return unavailable(); }
      if (!human) return reply(400, { error: "Verification failed. Please try again." });
    }

    const emailGate = await deps.throttle(sha256(`registration:email:${v.email}`), EMAIL_LIMIT.limit, EMAIL_LIMIT.windowSeconds);
    if (emailGate === "error") { deps.log("registration_throttle_unavailable"); return unavailable(); }
    if (emailGate === "limited") return reply(429, { error: "Too many attempts. Please try again later." });

    const { admin } = deps;
    const [profileMatch, userMatch] = await Promise.all([
      admin.from("profiles").select("id").eq("email", v.email).maybeSingle(),
      admin.from("users").select("id").eq("email", v.email).maybeSingle(),
    ]);
    // identical answer for an existing account: the endpoint never confirms whether an email is registered
    if (profileMatch.data || userMatch.data) return padded(reply(200, { success: REGISTRATION_SUCCESS }));

    const { data: created, error: authError } = await admin.auth.admin.createUser({
      email: v.email,
      password: v.password,
      email_confirm: true, // approval by an administrator gates access, not an email link this flow never sends
      user_metadata: {
        name: v.name, full_name: v.name, staff_id: v.staffId, phone: v.phone, system_type: v.systemType,
        role: v.systemType === "caterlink" ? "vendor" : v.role, team: v.team, station: v.station,
        driver_type: v.driverType, vendor_company: v.vendorCompany, vehicle_plate: v.vehiclePlate,
      },
    });
    if (authError || !created.user) {
      if (/already (been )?registered|already in use|user already|already exists/i.test(authError?.message ?? "")) return padded(reply(200, { success: REGISTRATION_SUCCESS }));
      deps.log("registration_auth_failed");
      return unavailable();
    }

    const write = v.systemType === "avsec"
      ? await admin.from("profiles").upsert({ id: created.user.id, email: v.email, name: v.name, staff_no: v.staffId, role: v.role, team: v.team, station: v.station, status: "pending" }, { onConflict: "id" })
      : await admin.from("users").upsert({ id: created.user.id, name: v.name, staff_id: v.staffId, email: v.email, role: "vendor", status: "pending" }, { onConflict: "id" });
    if (write.error) {
      deps.log("registration_profile_failed", { target: v.systemType });
      try { await admin.auth.admin.deleteUser(created.user.id); } catch { deps.log("registration_rollback_failed", { target: v.systemType }); }
      return reply(500, { error: "Could not complete your registration. Please try again." });
    }

    if (v.systemType === "avsec") {
      const requestWrite = await admin.from("user_registration_requests").insert({
        profile_id: created.user.id,
        requested_operating_entity_id: null,
        requested_aoc_id: null,
        requested_role_code: v.role.toLowerCase(),
        status: "pending",
        applicant_notes: `Public registration (${v.station} / ${v.team})`,
      });
      if (requestWrite.error) {
        deps.log("registration_request_failed", { target: v.systemType });
        try { await admin.from("profiles").delete().eq("id", created.user.id); } catch { deps.log("registration_profile_cleanup_failed"); }
        try { await admin.auth.admin.deleteUser(created.user.id); } catch { deps.log("registration_rollback_failed", { target: v.systemType }); }
        return reply(500, { error: "Could not complete your registration. Please try again." });
      }
    }

    return padded(reply(200, { success: REGISTRATION_SUCCESS }));
  } catch {
    deps.log("registration_unexpected_error");
    return reply(500, { error: "Could not complete your registration. Please try again." });
  }
}
