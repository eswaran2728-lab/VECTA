import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type WoisSupabaseClient = SupabaseClient<Database>;

/**
 * Phase 12 WOIS AI 2.0 tool boundary.
 *
 * Every tool here is a thin, narrow-typed wrapper around an EXISTING,
 * already-authorized secure RPC or RLS-protected table read from Phase 3-11.
 * No tool executes raw SQL, no tool accepts a table name, RPC name, URL,
 * storage path, or filter from the model/caller -- the allowlist below is
 * closed and every wrapper takes no arguments at all. Every wrapped query
 * derives the caller from this request's own authenticated Supabase client
 * (auth.uid() inside a SECURITY DEFINER function body, or an RLS policy
 * keyed to auth.uid()), so a model-supplied role/profile/AOC/station/team/
 * report id is never trusted: there is nowhere in this file to even pass
 * one through.
 *
 * Nothing here can approve/reject, publish, delete, upload, export, roster,
 * or otherwise write -- every wrapped path is read-only, matching Phase
 * 12's read-first constraint.
 *
 * Coverage of the Phase 12 correction's required tool list:
 *  - own roster/current duty        -> get_my_current_duty
 *  - own leave status               -> UNAVAILABLE (see note below)
 *  - own overtime status            -> get_my_overtime_status
 *  - role-permitted CaterLink info  -> get_caterlink_whitelist_summary
 *  - applicable announcements       -> get_visible_announcements
 *  - own report submissions         -> list_my_submissions
 *  - own notifications              -> get_my_notifications
 *  - active assignments             -> get_my_active_role_assignments
 *  - own registration state         -> get_my_registration_request
 *
 * "Own leave status" is NOT implemented: no existing secure RPC or RLS
 * path returns "my own leave requests" -- the only leave-related RPC
 * (list_pending_leave_for_reviewer_secure) is a REVIEWER's queue, not the
 * submitter's own status, and wrapping it would either leak other staff's
 * leave requests to an ordinary caller or require writing a new RPC, which
 * this phase's instructions explicitly forbid doing "merely to satisfy this
 * list." This gap is documented, not worked around.
 */

export type WoisToolName =
  | "list_my_submissions"
  | "get_my_notifications"
  | "get_my_active_role_assignments"
  | "get_visible_announcements"
  | "get_my_registration_request"
  | "get_my_current_duty"
  | "get_my_overtime_status"
  | "get_caterlink_whitelist_summary";

export interface WoisToolSpec {
  name: WoisToolName;
  description: string;
}

/** Names and descriptions only -- handed to a provider (including a real
 * LLM) so it can ask for one by name. Never a schema for arguments, since
 * none of these tools take any. */
export const WOIS_TOOL_SPECS: WoisToolSpec[] = [
  { name: "list_my_submissions", description: "List the caller's own recent report submissions and their status." },
  { name: "get_my_notifications", description: "List the caller's own recent notifications." },
  { name: "get_my_active_role_assignments", description: "List the caller's own currently active role assignments and scope." },
  { name: "get_visible_announcements", description: "List announcements currently visible to the caller." },
  { name: "get_my_registration_request", description: "Get the caller's own registration/approval status." },
  { name: "get_my_current_duty", description: "Get the caller's own roster entry and duty check-in status for today." },
  { name: "get_my_overtime_status", description: "List the caller's own overtime requests and their approval status." },
  { name: "get_caterlink_whitelist_summary", description: "Summarize CaterLink whitelist entries for the caller's own AOC, if the caller's role is authorized to see it." },
];

export interface WoisToolResult {
  ok: boolean;
  /** Minimal, already-redacted summary safe to show the user and store in
   * chat history -- never the raw RPC row set. */
  summary: string;
  /** Bounded, display-safe data for the UI to render (e.g. a short list). */
  data?: unknown;
  error?: "unknown_tool" | "malformed_arguments" | "authorization_denied" | "upstream_error";
}

const MAX_ROWS = 10;

async function callListMySubmissions(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("list_my_submissions_secure", { p_limit: MAX_ROWS });
  if (error) return { ok: false, summary: "Could not retrieve your submissions.", error: "authorization_denied" };
  const rows = (data ?? []) as Array<{ report_no: string; status: string }>;
  if (rows.length === 0) {
    return { ok: true, summary: "You have no recent report submissions.", data: [] };
  }
  return {
    ok: true,
    summary: `You have ${rows.length} recent submission(s). Most recent: ${rows[0].report_no} (${rows[0].status}).`,
    data: rows.map((r) => ({ report_no: r.report_no, status: r.status })),
  };
}

async function callGetMyNotifications(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("get_my_notifications", { p_limit: MAX_ROWS });
  if (error) return { ok: false, summary: "Could not retrieve your notifications.", error: "authorization_denied" };
  const rows = (data ?? []) as Array<{ event_type: string; read_at: string | null }>;
  const unread = rows.filter((r) => !r.read_at).length;
  return {
    ok: true,
    summary: unread > 0 ? `You have ${unread} unread notification(s) out of ${rows.length} recent.` : `No unread notifications (${rows.length} recent).`,
    data: rows.map((r) => ({ event_type: r.event_type, read: Boolean(r.read_at) })),
  };
}

async function callGetMyActiveRoleAssignments(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("get_my_active_role_assignments");
  if (error) return { ok: false, summary: "Could not retrieve your role assignments.", error: "authorization_denied" };
  const rows = (data ?? []) as Array<{ role_code: string; aoc_code: string | null; station_code: string | null }>;
  if (rows.length === 0) {
    return { ok: true, summary: "You have no active role assignments.", data: [] };
  }
  const summary = rows.map((r) => `${r.role_code}${r.aoc_code ? ` (${r.aoc_code})` : ""}`).join(", ");
  return { ok: true, summary: `Your active role scope: ${summary}.`, data: rows };
}

async function callGetVisibleAnnouncements(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("get_visible_announcements_secure", {
    p_scope: null,
    p_category: null,
    p_include_archived: false,
  });
  if (error) return { ok: false, summary: "Could not retrieve your announcements.", error: "authorization_denied" };
  const rows = (data ?? []) as Array<{ title: string; priority: string }>;
  if (rows.length === 0) {
    return { ok: true, summary: "No active announcements apply to you right now.", data: [] };
  }
  return {
    ok: true,
    summary: `${rows.length} announcement(s) apply to you. Most recent: "${rows[0].title}" (${rows[0].priority}).`,
    data: rows.slice(0, MAX_ROWS).map((r) => ({ title: r.title, priority: r.priority })),
  };
}

async function callGetMyRegistrationRequest(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("get_my_registration_request");
  if (error) return { ok: false, summary: "Could not retrieve your registration status.", error: "authorization_denied" };
  const rows = (data ?? []) as Array<{ status: string }>;
  if (rows.length === 0) {
    return { ok: true, summary: "No registration request found for your account.", data: null };
  }
  return { ok: true, summary: `Your registration status: ${rows[0].status}.`, data: rows[0] };
}

/** Today's roster entry and duty-record status. Mirrors exactly what
 * app/(avsec)/avsec/duty already queries (getTodayRoster + getTodayDutyRecord) --
 * both RLS-scoped to the caller's own station/team and profile_id, never a
 * caller-supplied one, matching that code's own documented invariant
 * ("profile_id is implied by RLS -- no explicit filter is needed to scope
 * this to the caller"). */
async function callGetMyCurrentDuty(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { ok: false, summary: "Could not identify the caller.", error: "authorization_denied" };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("station, team")
    .eq("id", userId)
    .maybeSingle();
  if (profileError || !profile?.station || !profile?.team) {
    return { ok: true, summary: "No station/team is assigned to your profile, so there is no roster to show.", data: null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: roster } = await supabase
    .from("team_rosters")
    .select("shift_code, start_time, end_time")
    .eq("station", profile.station)
    .eq("team", profile.team)
    .eq("roster_date", today)
    .maybeSingle();

  if (!roster) {
    return { ok: true, summary: "You are not rostered for today.", data: null };
  }

  const { data: dutyRecord } = await supabase
    .from("duty_records")
    .select("check_in_at, check_out_at, status")
    .eq("profile_id", userId)
    .eq("duty_date", today)
    .eq("shift_code", roster.shift_code)
    .maybeSingle();

  const checkInState = dutyRecord?.check_in_at
    ? dutyRecord?.check_out_at
      ? "checked out"
      : "checked in, not yet checked out"
    : "not yet checked in";

  return {
    ok: true,
    summary: `Today's shift: ${roster.shift_code} (${roster.start_time ?? "?"}-${roster.end_time ?? "?"}). Status: ${checkInState}.`,
    data: { shift_code: roster.shift_code, status: checkInState },
  };
}

/** The caller's own overtime requests, deliberately narrowed to
 * profile_id === caller even though the underlying RLS also allows a
 * monitor (supervisor) to see requests they review -- a chat tool answering
 * "my overtime status" should only ever surface the caller's OWN records,
 * never the broader monitoring view the same RLS permits for the page UI. */
async function callGetMyOvertimeStatus(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { ok: false, summary: "Could not identify the caller.", error: "authorization_denied" };

  const { data, error } = await supabase
    .from("overtime_requests")
    .select("work_date, hours, status")
    .eq("profile_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  if (error) return { ok: false, summary: "Could not retrieve your overtime status.", error: "authorization_denied" };
  const rows = data ?? [];
  if (rows.length === 0) {
    return { ok: true, summary: "You have no overtime requests on record.", data: [] };
  }
  return {
    ok: true,
    summary: `You have ${rows.length} overtime request(s). Most recent: ${rows[0].work_date} (${rows[0].hours}h, ${rows[0].status}).`,
    data: rows,
  };
}

/** Summarized counts only (never the full whitelist dump) for the caller's
 * own AOC. The underlying RPC already requires an active 'caterlink_management'
 * assignment and fails closed (raises) for anyone else -- this wrapper adds
 * no authorization of its own and cannot loosen what the RPC already
 * enforces; it only shrinks a successful result down to counts. */
async function callGetCaterlinkWhitelistSummary(supabase: WoisSupabaseClient): Promise<WoisToolResult> {
  const { data, error } = await supabase.rpc("list_caterlink_whitelist_secure", {
    p_aoc_id: null,
    p_entry_type: null,
    p_status: null,
    p_search: null,
  });
  if (error) {
    return { ok: false, summary: "CaterLink whitelist details are only available to CaterLink Management.", error: "authorization_denied" };
  }
  const rows = (data ?? []) as Array<{ entry_type: string; status: string }>;
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    const key = `${r.entry_type}:${r.status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    summary: rows.length > 0 ? `CaterLink whitelist: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}.` : "No CaterLink whitelist entries for your AOC.",
    data: counts,
  };
}

const ALLOWED_TOOLS: Record<WoisToolName, (supabase: WoisSupabaseClient) => Promise<WoisToolResult>> = {
  list_my_submissions: callListMySubmissions,
  get_my_notifications: callGetMyNotifications,
  get_my_active_role_assignments: callGetMyActiveRoleAssignments,
  get_visible_announcements: callGetVisibleAnnouncements,
  get_my_registration_request: callGetMyRegistrationRequest,
  get_my_current_duty: callGetMyCurrentDuty,
  get_my_overtime_status: callGetMyOvertimeStatus,
  get_caterlink_whitelist_summary: callGetCaterlinkWhitelistSummary,
};

export function isKnownWoisTool(name: string): name is WoisToolName {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TOOLS, name);
}

/**
 * Execute a single allowlisted tool. Rejects anything not in the fixed
 * allowlist above (unknown-tool rejection) and never accepts caller-supplied
 * arguments -- every wrapper above takes none.
 */
export async function executeWoisTool(
  toolName: string,
  supabase: WoisSupabaseClient
): Promise<WoisToolResult> {
  if (!isKnownWoisTool(toolName)) {
    return { ok: false, summary: "That action is not available.", error: "unknown_tool" };
  }
  try {
    return await ALLOWED_TOOLS[toolName](supabase);
  } catch {
    return { ok: false, summary: "That action could not be completed.", error: "upstream_error" };
  }
}

/**
 * Deterministic tool-intent matcher. Deliberately simple and keyword-based
 * (not model-driven) so the set of tools that can ever run from the
 * deterministic engine is fully enumerable and testable.
 */
export function matchWoisToolIntent(query: string): WoisToolName | null {
  const q = query.toLowerCase();
  if (q.includes("pending report") || q.includes("my submission") || q.includes("my report")) {
    return "list_my_submissions";
  }
  if (q.includes("my notification")) {
    return "get_my_notifications";
  }
  if (q.includes("what reports can my role") || q.includes("my role") || q.includes("my access") || q.includes("my scope")) {
    return "get_my_active_role_assignments";
  }
  if (q.includes("announcement") && (q.includes("apply to me") || q.includes("for me") || q.includes("my announcement"))) {
    return "get_visible_announcements";
  }
  if (q.includes("registration status") || q.includes("my registration")) {
    return "get_my_registration_request";
  }
  if (q.includes("my duty") || q.includes("my roster") || q.includes("my shift") || q.includes("current duty")) {
    return "get_my_current_duty";
  }
  if (q.includes("my overtime") || q.includes("my ot status")) {
    return "get_my_overtime_status";
  }
  if (q.includes("caterlink") && (q.includes("my station") || q.includes("whitelist"))) {
    return "get_caterlink_whitelist_summary";
  }
  return null;
}
