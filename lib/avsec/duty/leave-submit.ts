import type { LeaveType, LeaveApprovalStatus } from "./absence-logic";

/**
 * Pure helpers for submitting a leave application through submit_leave_application_secure(). The database derives the caller, the station,
 * the team, the shift and the compliance gap; the client sends only the leave type, the dates and the remarks.
 */
export const GENERIC_LEAVE_ERROR = "Your leave application could not be recorded. Please try again.";

export interface LeaveSubmitInput {
  leaveType?: LeaveType;
  startDate?: string;
  endDate?: string;
  remarks: string;
}

export interface LeaveSubmitResult {
  error: string | null;
  success: boolean;
  leaveType?: LeaveType;
  startDate?: string;
  endDate?: string;
  approvalStatus?: LeaveApprovalStatus;
  status?: "green" | "red" | null;
  formattedGap?: string;
  submittedAt?: string;
}

export function leaveRpcArgs(input: LeaveSubmitInput) {
  return {
    p_leave_type: input.leaveType ?? "absent",
    p_start_date: input.startDate || undefined,
    p_end_date: input.endDate || undefined,
    p_remarks: (input.remarks ?? "").trim(),
  };
}

interface LeaveRpcRow {
  notice_id?: string | null;
  result_approval_status?: string | null;
  result_status?: string | null;
  result_formatted_gap?: string | null;
  result_submitted_at?: string | null;
  result_start_date?: string | null;
  result_end_date?: string | null;
  result_leave_type?: string | null;
}

/**
 * Maps the RPC outcome to the UI contract. A refusal the database wrote itself (SQLSTATE P0001: not approved, already checked in,
 * duplicate, bad dates...) is shown as written; anything else (constraints, permissions, connection) becomes a generic message so no
 * table, column or SQL text reaches the user. An empty result is a failure, never a success.
 */
export function mapLeaveRpcResult(
  data: LeaveRpcRow[] | null | undefined,
  error: { code?: string | null; message?: string | null } | null,
): LeaveSubmitResult {
  if (error) {
    return { error: error.code === "P0001" && error.message ? error.message : GENERIC_LEAVE_ERROR, success: false };
  }
  const row = data?.[0];
  if (!row?.notice_id) return { error: GENERIC_LEAVE_ERROR, success: false };
  return {
    error: null,
    success: true,
    leaveType: row.result_leave_type as LeaveType,
    startDate: row.result_start_date ?? undefined,
    endDate: row.result_end_date ?? undefined,
    approvalStatus: (row.result_approval_status ?? "pending") as LeaveApprovalStatus,
    status: (row.result_status as "green" | "red" | null) ?? null,
    formattedGap: row.result_formatted_gap ?? undefined,
    submittedAt: row.result_submitted_at ?? undefined,
  };
}
