import type { WoisSuggestedAction } from "@/lib/avsec/types";
import { DAILY_REPORT_ROLES, type ProfileRole } from "@/lib/avsec/auth";

/**
 * Role-adapted suggested prompts. Every suggestion here is either a static
 * SOP/app-help question the deterministic engine already answers, or a
 * "show my ..." phrase that resolves to one of the allowlisted read-only
 * tools in lib/wois/tools.ts -- nothing here can surface an action the
 * caller isn't already authorized for, because the underlying tool/engine
 * path re-checks authorization itself regardless of what the UI offers.
 */
const BASE_SUGGESTIONS: WoisSuggestedAction[] = [
  { label: "What announcements apply to me?", query: "What announcements apply to me?" },
  { label: "What reports can my role access?", query: "What reports can my role access?" },
  { label: "How do I submit an OT request?", query: "How do I submit an Overtime (OT) request in VECTA?" },
  { label: "A330 search timing", query: "What is the minimum aircraft search timing for an A330?" },
];

const REPORT_SUBMITTER_SUGGESTIONS: WoisSuggestedAction[] = [
  { label: "Show my pending reports", query: "Show my pending reports" },
];

export function getWoisSuggestedActions(role?: string | null): WoisSuggestedAction[] {
  const suggestions = [...BASE_SUGGESTIONS];
  if (role && (DAILY_REPORT_ROLES as readonly string[]).includes(role.toUpperCase() as ProfileRole)) {
    suggestions.push(...REPORT_SUBMITTER_SUGGESTIONS);
  }
  return suggestions;
}
