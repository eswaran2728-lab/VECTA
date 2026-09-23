import "server-only";

import { hasOpenDutyCheckIn } from "@/lib/avsec/duty/checkin-queries";

/**
 * On-duty gate for the unified AVSEC checkpoint authorization path
 * (requireCheckpointRole in lib/icms/auth.ts; scanTransaction in
 * lib/icms/actions/scan.ts). Applies ONLY where access is granted via the
 * ops_group union (opsGroupCanAccessCheckpoint — an ASO/SO/DSE completing a
 * non-Hub checkpoint, possibly cross-branch) — never to the literal
 * single-purpose checkpoint-role accounts (post2_avsec/post6_avsec/
 * receiver/hub_avsec/redq_avsec), which have no roster/duty-check-in
 * concept of their own (see shadow-user.ts) and are unaffected by this.
 *
 * Deliberately reuses hasOpenDutyCheckIn() (lib/avsec/duty/checkin-queries.ts)
 * — the SAME source of truth that already gates report submission
 * (lib/avsec/reports/actions.ts's ensureCheckedIn) — rather than adding a
 * second duty/attendance table or schema. "On duty" here means exactly what
 * it means there: an open duty_records row for today (checked in, not yet
 * checked out), regardless of shift or roster team.
 */
export const NOT_ON_DUTY_ERROR = "You must be checked in for duty (/duty) to process this checkpoint.";

export async function ensureOnDutyForCheckpoint(profileId: string): Promise<string | null> {
  const checkedIn = await hasOpenDutyCheckIn(profileId);
  return checkedIn ? null : NOT_ON_DUTY_ERROR;
}
