import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type WoisSupabaseClient = SupabaseClient<Database>;

/**
 * Phase 12 WOIS AI 2.0 tool boundary.
 *
 * Every tool here is a thin, narrow-typed wrapper around an EXISTING,
 * already-authorized secure RPC from Phase 3-11. No tool executes raw SQL,
 * no tool accepts a table name, RPC name, URL, storage path, or filter from
 * the model -- the allowlist below is closed and the arguments each tool
 * accepts are fixed, typed, and bounded. Every wrapped RPC derives the
 * caller from auth.uid() inside its own SECURITY DEFINER body, so a
 * model-supplied role/profile/AOC/station/team/report id is never trusted:
 * there is nowhere in this file to even pass one through.
 *
 * Nothing here can approve/reject, publish, delete, upload, export, or
 * otherwise write -- every wrapped RPC is read-only ("Show me ..." style),
 * matching Phase 12's read-first constraint.
 */

export type WoisToolName =
  | "list_my_submissions"
  | "get_my_notifications"
  | "get_my_active_role_assignments"
  | "get_visible_announcements"
  | "get_my_registration_request";

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

const ALLOWED_TOOLS: Record<WoisToolName, (supabase: WoisSupabaseClient) => Promise<WoisToolResult>> = {
  list_my_submissions: callListMySubmissions,
  get_my_notifications: callGetMyNotifications,
  get_my_active_role_assignments: callGetMyActiveRoleAssignments,
  get_visible_announcements: callGetVisibleAnnouncements,
  get_my_registration_request: callGetMyRegistrationRequest,
};

export function isKnownWoisTool(name: string): name is WoisToolName {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TOOLS, name);
}

/**
 * Execute a single allowlisted tool. Rejects anything not in the fixed
 * allowlist above (unknown-tool rejection) and never accepts caller-supplied
 * arguments -- each wrapper above takes no model-controlled input at all,
 * since every candidate in Phase 12's "suggested actions" list resolves to
 * "show MY ..." (the caller's own scope), nothing parameterized by identity.
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
 * (not model-driven) so the set of tools that can ever run is fully
 * enumerable and testable -- the model/engine never decides which tool to
 * call by free-form generation.
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
  return null;
}
