/**
 * Phase 10: Anonymous Discussion Board Types
 *
 * ANONYMITY SECURITY ENFORCEMENT:
 * - Public thread & reply types strictly exclude profile IDs, real names,
 *   staff numbers, and emails.
 * - Only the thread-scoped anonymous alias is visible to participants.
 * - Identity resolution type is restricted to the privileged moderator audit path.
 */

export interface DiscussionCategory {
  id: string;
  code: string;
  display_name: string;
  description: string;
  aoc_id: string | null;
  sort_order: number;
}

export type ThreadStatus = "open" | "locked" | "removed";
export type ReplyStatus = "visible" | "removed";

export interface DiscussionThreadSummary {
  id: string;
  category_id: string;
  category_name?: string;
  title: string;
  author_alias: string;
  status: ThreadStatus;
  report_count: number;
  reply_count: number;
  created_at: string;
  edited_at: string | null;
}

export interface DiscussionReply {
  id: string;
  body: string;
  author_alias: string;
  status: ReplyStatus;
  created_at: string;
  edited_at: string | null;
}

export interface DiscussionThreadDetail {
  id: string;
  category_id: string;
  category_name?: string;
  title: string;
  body: string;
  author_alias: string;
  status: ThreadStatus;
  created_at: string;
  edited_at: string | null;
  replies: DiscussionReply[];
}

export type ReportReason =
  | "harassment"
  | "threat"
  | "sensitive_information"
  | "spam"
  | "inappropriate_content"
  | "security_concern"
  | "other";

export const REPORT_REASONS: { code: ReportReason; label: string; description: string }[] = [
  { code: "harassment", label: "Harassment or Bullying", description: "Targeted hostility, intimidation, or personal attacks." },
  { code: "threat", label: "Safety Threat or Violence", description: "Direct or implied threats to person, aircraft, or facility." },
  { code: "sensitive_information", label: "Sensitive / Confidential Leak", description: "Operational security secrets, passwords, or PII." },
  { code: "security_concern", label: "Security Vulnerability", description: "Airport or system security risks that must be escalated." },
  { code: "spam", label: "Spam or Advertising", description: "Irrelevant, promotional, or repetitive commercial posts." },
  { code: "inappropriate_content", label: "Inappropriate Content", description: "Content violating workplace guidelines or decency standards." },
  { code: "other", label: "Other Policy Violation", description: "Any other breach of VECTA communication policies." },
];

export type ReportStatus = "open" | "reviewed" | "dismissed";

export interface DiscussionReport {
  id: string;
  content_type: "thread" | "reply";
  content_id: string;
  thread_id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  created_at: string;
}

export type ModerationAction = "hide" | "restore" | "lock" | "unlock";

export interface DiscussionResolvedIdentity {
  profile_id: string;
  name: string;
  staff_no: string;
  email: string;
}
