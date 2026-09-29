"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentProfile } from "@/lib/avsec/auth";
import { hasOpenDutyCheckIn } from "@/lib/avsec/duty/checkin-queries";
import { sec016Schema } from "@/lib/avsec/schemas/sec016";
import { sec014Schema } from "@/lib/avsec/schemas/sec014";
import { sec029Schema } from "@/lib/avsec/schemas/sec029";
import { sec018Schema } from "@/lib/avsec/schemas/sec018";
import { sec033Schema } from "@/lib/avsec/schemas/sec033";
import { sec013Schema } from "@/lib/avsec/schemas/sec013";
import { offloadSchema } from "@/lib/avsec/schemas/offload";
import { clearDraft } from "@/lib/avsec/reports/drafts";
import { notifyReportSubmission } from "@/lib/avsec/email/notifyReportSubmission";
import {
  sec016EmailFields,
  sec014EmailFields,
  sec029EmailFields,
  sec018EmailFields,
  sec033EmailFields,
  sec013EmailFields,
  offloadEmailFields,
} from "@/lib/avsec/email/reportFields";

export interface ActionResult {
  ok: boolean;
  id?: string;
  submittedAt?: string;
  reportNo?: string;
  error?: string;
}

async function requireProfileId(): Promise<{
  id: string;
  station: string;
  team: string;
  ops_group?: string | null;
  role: string;
} | null> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station || !profile.team) return null;
  return {
    id: profile.id,
    station: profile.station,
    team: profile.team,
    ops_group: profile.ops_group,
    role: profile.role,
  };
}

// Reports can only be filed while actually on duty — mirrors the dashboard's compliance
// panel, which already flags a submission from someone who never checked in.
async function ensureCheckedIn(profileId: string): Promise<string | null> {
  const checkedIn = await hasOpenDutyCheckIn(profileId);
  return checkedIn ? null : "You must check in for duty (/duty) before submitting a report.";
}

const SOURCE_TABLE_BY_TYPE: Record<string, string> = {
  sec013: "report_sec013",
  sec014: "report_sec014",
  sec016: "report_sec016",
  sec018: "report_sec018",
  sec029: "report_sec029",
  sec033: "report_sec033",
  offload: "offload_records",
};

/** Resume a submission whose finalization RPC failed after its child
 * rows were already written successfully (review round 7, case (b) of
 * the two possible partial-failure states -- see the PART S4 comment in
 * the Phase 6 migration for the full analysis: a multi-row child INSERT
 * is atomic in Postgres, so a report reaches this state only when child
 * rows are already complete and correct, and only the report_index_
 * queue entry is missing). This retries JUST the finalization step
 * against the SAME existing report id -- it never re-inserts a parent
 * row and never creates a duplicate report. mark_report_ready_for_
 * indexing() is itself idempotent and re-validates completeness on
 * every call, so this is safe to call repeatedly, including on a report
 * that was already successfully finalized (it will simply no-op).
 *
 * NOTE (scope boundary, honestly documented rather than silently
 * declared solved): this does NOT resume case (a) -- a report whose
 * child-row INSERT itself failed, leaving zero child rows. That case
 * requires re-submitting the original child-row data (which this
 * server-only function has no access to; the client's form still holds
 * it, but wiring a "resume with existing id" parameter through all 7
 * submitXXX actions' zod-validated inputs is a larger, separate change
 * not made this round). A case-(a) report remains a harmless orphan --
 * never indexed, never searchable, but still visible to its own
 * submitter via getMySubmissions() regardless of finalization state --
 * until either this gap is closed in a future round or the user
 * resubmits the report (creating a new, separate parent; the orphan is
 * never deleted or overwritten). */
export async function resumeReportFinalization(reportType: string, reportId: string): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const sourceTable = SOURCE_TABLE_BY_TYPE[reportType];
  if (!sourceTable) return { ok: false, error: "Unknown report type." };

  const supabase = await createClient();
  const { data: childCount, error: countError } = await supabase.rpc("get_child_row_count_secure", {
    p_source_table: sourceTable,
    p_source_id: reportId,
  });
  if (countError) return { ok: false, error: countError.message };

  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", {
    p_source_table: sourceTable,
    p_source_id: reportId,
    p_expected_child_count: childCount ?? 0,
  });
  if (readyError) {
    return { ok: false, error: `Still could not be finalized: ${readyError.message}`, id: reportId };
  }
  return { ok: true, id: reportId };
}

// ---------- SEC 016 ----------

export async function submitSec016(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec016Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const regNoUpper = v.reg_no.trim().toUpperCase();
  let searchOverdueFlag = false;
  let searchRemark: string | null = null;
  let discrepanciesFinal = v.discrepancies;

  // For departures: check if aircraft was on ground >= 4 hours on Bay Board
  if (v.flight_type === "departure") {
    const { data: openBay } = await supabase
      .from("bay_board")
      .select("id, on_ground_since")
      .eq("station", v.station)
      .eq("reg_no", regNoUpper)
      .is("cleared_at", null)
      .order("on_ground_since", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openBay) {
      const hoursOnGround = (Date.now() - new Date(openBay.on_ground_since).getTime()) / 3600000;
      if (hoursOnGround >= 4 && !v.aircraft_search_completed) {
        searchOverdueFlag = true;
        searchRemark = "Aircraft Search not completed — aircraft on ground >4h";
        if (
          !discrepanciesFinal ||
          discrepanciesFinal === "N/A" ||
          discrepanciesFinal === "NONE" ||
          discrepanciesFinal === "NIL"
        ) {
          discrepanciesFinal = searchRemark;
        } else if (!discrepanciesFinal.includes("Aircraft Search not completed")) {
          discrepanciesFinal = `${discrepanciesFinal}\n[AUTO-FLAG] ${searchRemark}`;
        }
      }
    }
  }

  // Workflow Upgrades item 6: if a prior shift handover named this same
  // flight (matched by flight number + station, same as the Flight Detail
  // Page's matching rule) and this SEC016 is being filed by someone other
  // than who handed it over, surface the handover context as a remark —
  // this is happening at initial insert, not a post-hoc mutation of an
  // already-submitted report.
  const { data: handoverMatch } = await supabase
    .from("shift_handovers")
    .select("staff_name, created_at, outgoing_profile_id")
    .eq("station", v.station)
    .ilike("flight_number", v.flight.trim())
    .neq("outgoing_profile_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (handoverMatch) {
    const handoverNote = `[HANDOVER] Took over Flight ${v.flight} from ${handoverMatch.staff_name} at ${new Date(handoverMatch.created_at).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}.`;
    discrepanciesFinal =
      !discrepanciesFinal || ["N/A", "NONE", "NIL"].includes(discrepanciesFinal)
        ? handoverNote
        : `${discrepanciesFinal}\n${handoverNote}`;
  }

  const { data, error } = await supabase
    .from("report_sec016")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      flight_type: v.flight_type,
      aircraft_search_completed: v.aircraft_search_completed,
      search_overdue_flag: searchOverdueFlag,
      search_remark: searchRemark,
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_no: v.staff_no,
      duty_date: v.duty_date,
      duty_hour: v.duty_hour,
      flight: v.flight,
      origin_arr_dep: v.origin_arr_dep,
      assisted_by: v.assisted_by,
      aircraft_type: v.aircraft_type,
      aircraft_type_other: v.aircraft_type_other || null,
      reg_no: regNoUpper,
      sta_std: v.sta_std,
      ata_atd: v.ata_atd,
      bay_no: v.bay_no,
      reason_for_delay: v.reason_for_delay || null,
      do_infmd: v.do_infmd,
      inbound_baggage: v.inbound_baggage || null,
      outbound_baggage: v.outbound_baggage || null,
      inbound_cargo: v.inbound_cargo || null,
      outbound_cargo: v.outbound_cargo || null,
      inbound_co_mail: v.inbound_co_mail || null,
      outbound_co_mail: v.outbound_co_mail || null,
      shift_leader: v.shift_leader,
      ramp_agents_baggage: v.ramp_agents_baggage,
      ramp_agents_cargo: v.ramp_agents_cargo,
      cargo_hold_checked: v.cargo_hold_checked,
      staff_frisked: v.staff_frisked,
      cabin_check: v.cabin_check || null,
      discrepancies: discrepanciesFinal,
      offload_baggage_tag_no: v.offload_baggage_tag_no || null,
      offload_remark: v.offload_remark || null,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  // Bay Board auto-linkage (Operation AVSEC only)
  const isOps = profile.ops_group === "operation_avsec" || !profile.ops_group;
  if (isOps) {
    if (v.flight_type === "arrival") {
      await supabase.from("bay_board").insert({
        station: v.station,
        reg_no: regNoUpper,
        aircraft_type: v.aircraft_type === "Other" ? v.aircraft_type_other : v.aircraft_type,
        bay: v.bay_no,
        flight: v.flight.trim().toUpperCase(),
        arrival_report_id: data.id,
        on_ground_since: new Date().toISOString(),
        is_manual: false,
        created_by: profile.id,
      });
    } else if (v.flight_type === "departure") {
      await supabase
        .from("bay_board")
        .update({
          cleared_at: new Date().toISOString(),
          cleared_by_report_id: data.id,
          departure_report_id: data.id,
        })
        .eq("station", v.station)
        .eq("reg_no", regNoUpper)
        .is("cleared_at", null);
    }
    revalidatePath("/avsec/bay-board");
  }

  // Report completion is now explicit (review round 5/6): parent + any
  // Bay Board side-effects are done, so this report is safe for the
  // repository to index -- see mark_report_ready_for_indexing() in the
  // Phase 6 migration. report_sec016 has no child table, so the
  // expected count is always 0. The RPC's own error is checked and
  // propagated (round 6) -- a failed finalization must not be reported
  // to the caller as a successful submission; the report row itself
  // still exists and can be finalized later by retrying this same RPC
  // call (idempotent, ON CONFLICT DO NOTHING) without resubmitting.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec016", p_source_id: data.id, p_expected_child_count: 0 });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${data.id}.` };
  }
  await clearDraft("sec016");
  await notifyReportSubmission({
    reportType: "sec016",
    submittedAt: data.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_no,
    fields: sec016EmailFields({ ...v, discrepancies: discrepanciesFinal }),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: data.id, submittedAt: data.submitted_at ?? new Date().toISOString(), reportNo: data.report_no ?? undefined };
}

// ---------- SEC 014 ----------

export async function submitSec014(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec014Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const { data: report, error } = await supabase
    .from("report_sec014")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      date_time_in: v.date_time_in,
      date_time_out: v.date_time_out,
      remark: v.remark,
      acknowledgement: v.acknowledgement,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  if (v.patrols.length > 0) {
    const rows = v.patrols.map((p, idx) => ({
      report_id: report.id,
      entry_no: idx + 1,
      location: p.location,
      time_from: p.time_from || null,
      time_to: p.time_to || null,
      description: p.description,
    }));
    const { error: patrolError } = await supabase.from("report_sec014_patrols").insert(rows);
    if (patrolError) return { ok: false, error: patrolError.message, id: report.id };
  }

  // Explicit indexing-readiness call, made only after the optional
  // patrol child rows above have already been written -- see the
  // sec016 comment above for why this replaced automatic enqueueing.
  // The expected count (v.patrols.length) is verified against the
  // database's own count inside the RPC, not merely trusted.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec014", p_source_id: report.id, p_expected_child_count: v.patrols.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("sec014");
  await notifyReportSubmission({
    reportType: "sec014",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec014EmailFields(v),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- SEC 029 ----------

export async function submitSec029(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec029Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();

  // Re-verify the selected Supervising Officer server-side — the dropdown itself is
  // just UI, not a security boundary. Must be an SO/DSE on the submitter's own team,
  // station, and ops_group (see getEligibleSupervisingOfficers). Admin client here for
  // the same reason as that function: profiles' own RLS only lets the ASO read their
  // own row, so a plain RLS-bound read would never find the officer to check against.
  const { data: officer } = await createAdminClient()
    .from("profiles")
    .select("id, name, staff_no, role, station, team, ops_group, status")
    .eq("id", v.supervising_officer_profile_id)
    .maybeSingle();
  const officerEligible =
    officer &&
    officer.status === "approved" &&
    (officer.role === "SO" || officer.role === "DSE") &&
    officer.station === profile.station &&
    officer.team === profile.team &&
    (profile.ops_group ? officer.ops_group === profile.ops_group : true);
  if (!officerEligible) {
    return {
      ok: false,
      error: "Selected Supervising Officer is not a valid SO/DSE on your team — please re-select.",
    };
  }

  const { data: report, error } = await supabase
    .from("report_sec029")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      supervising_officer_name: officer.name,
      supervising_officer_id: officer.staff_no,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      assisted_by_name: v.assisted_by_name,
      assisted_by_id: v.assisted_by_id,
      aircraft_type: v.aircraft_type,
      aircraft_type_other: v.aircraft_type === "Others" ? v.aircraft_type_other : null,
      flight_no: v.flight_no,
      flight_destination: v.flight_destination || null,
      aircraft_registration: v.aircraft_registration,
      std: v.std,
      parking_bay: v.parking_bay,
      time_commence: v.time_commence,
      time_completed: v.time_completed,
      pic_informed: v.pic_informed,
      declaration: v.declaration,
      d_remark: v.d_remark || null,
      acknowledgement: v.acknowledgement,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  const itemRows = v.items.map((item) => ({
    report_id: report.id,
    item_code: item.item_code,
    checked: item.checked,
    remark_type: item.remark_type,
    remark_text: item.remark_text || null,
  }));
  const { error: itemError } = await supabase.from("report_sec029_items").insert(itemRows);
  if (itemError) return { ok: false, error: itemError.message, id: report.id };

  // Clear any open Bay Board entry for this registration at this station.
  await supabase
    .from("bay_board")
    .update({ cleared_by_report_id: report.id, cleared_at: new Date().toISOString() })
    .eq("station", v.station)
    .eq("reg_no", v.aircraft_registration)
    .is("cleared_at", null);

  // Explicit indexing-readiness call, made only after the item child
  // rows above have already been written.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec029", p_source_id: report.id, p_expected_child_count: v.items.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("sec029");
  await notifyReportSubmission({
    reportType: "sec029",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec029EmailFields({ ...v, supervising_officer_name: officer.name, supervising_officer_id: officer.staff_no }),
  });
  revalidatePath("/avsec/history");
  revalidatePath("/avsec/bay-board");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- SEC 018 ----------

export async function submitSec018(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec018Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const { data: report, error } = await supabase
    .from("report_sec018")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      date_time: v.date_time,
      acknowledgement: v.acknowledgement,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  if (v.patrols.length > 0) {
    const rows = v.patrols.map((p, idx) => ({
      report_id: report.id,
      entry_no: idx + 1,
      time_from: p.time_from || null,
      time_to: p.time_to || null,
      parking_bay: p.parking_bay || null,
      aircraft_type: p.aircraft_type || null,
      reg_no: p.reg_no || null,
      description: p.description,
    }));
    const { error: patrolError } = await supabase.from("report_sec018_patrols").insert(rows);
    if (patrolError) return { ok: false, error: patrolError.message, id: report.id };
  }

  // Explicit indexing-readiness call, made only after the optional
  // patrol child rows above have already been written.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec018", p_source_id: report.id, p_expected_child_count: v.patrols.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("sec018");
  await notifyReportSubmission({
    reportType: "sec018",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: "",
    fields: sec018EmailFields(v),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- SEC 033 ----------

export async function submitSec033(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec033Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const { data: report, error } = await supabase
    .from("report_sec033")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      report_date: v.report_date,
      report_time: v.report_time,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  const rows = v.hold_checks.map((h, idx) => ({
    report_id: report.id,
    entry_no: idx + 1,
    parking_bay_no: h.parking_bay_no,
    aircraft_registration_no: h.aircraft_registration_no,
    remarks: h.remarks || null,
  }));
  const { error: holdCheckError } = await supabase.from("report_sec033_hold_checks").insert(rows);
  if (holdCheckError) return { ok: false, error: holdCheckError.message, id: report.id };

  // Explicit indexing-readiness call, made only after the hold-check
  // child rows above have already been written.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec033", p_source_id: report.id, p_expected_child_count: v.hold_checks.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("sec033");
  await notifyReportSubmission({
    reportType: "sec033",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec033EmailFields(v),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- SEC 013 ----------

export async function submitSec013(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = sec013Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const { data: report, error } = await supabase
    .from("report_sec013")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      date_time_in: v.date_time_in,
      date_time_out: v.date_time_out,
      remark: v.remark || null,
      corrective_action: v.corrective_action || null,
      acknowledgement: v.acknowledgement,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  const rows = v.profiling_duties.map((d, idx) => ({
    report_id: report.id,
    entry_no: idx + 1,
    duty_area: d.duty_area,
    time_from: d.time_from,
    time_to: d.time_to,
    location: d.location,
    sector_flight: d.sector_flight,
    description: d.description,
    incident_remark: d.incident_remark || null,
  }));
  const { error: dutyError } = await supabase.from("report_sec013_profiling_duties").insert(rows);
  if (dutyError) return { ok: false, error: dutyError.message, id: report.id };

  // Explicit indexing-readiness call, made only after the profiling-duty
  // child rows above have already been written.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "report_sec013", p_source_id: report.id, p_expected_child_count: v.profiling_duties.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("sec013");
  await notifyReportSubmission({
    reportType: "sec013",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec013EmailFields(v),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- Offload Information (Departure Flight) ----------

export async function submitOffload(input: unknown): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };
  const checkInError = await ensureCheckedIn(profile.id);
  if (checkInError) return { ok: false, error: checkInError };

  const parsed = offloadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const v = parsed.data;

  const supabase = await createClient();
  const { data: report, error } = await supabase
    .from("offload_records")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      flight_no: v.flight_no,
      destination: v.destination,
      aircraft_registration: v.aircraft_registration,
      flight_date: v.flight_date,
      std: v.std || null,
      total_bags: v.items.length,
      remark: v.remark || null,
      verified_by_dse_name: v.verified_by_dse_name || null,
      verified_by_dse_id: v.verified_by_dse_id || null,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };

  const rows = v.items.map((it, idx) => ({
    report_id: report.id,
    entry_no: idx + 1,
    baggage_tag_no: it.baggage_tag_no,
    reason: it.reason || null,
    weight_kg: it.weight_kg ? Number(it.weight_kg) : null,
  }));
  const { error: itemsError } = await supabase.from("offload_items").insert(rows);
  if (itemsError) return { ok: false, error: itemsError.message, id: report.id };

  // Explicit indexing-readiness call, made only after the offload item
  // child rows above have already been written.
  const { error: readyError } = await supabase.rpc("mark_report_ready_for_indexing", { p_source_table: "offload_records", p_source_id: report.id, p_expected_child_count: v.items.length });
  if (readyError) {
    return { ok: false, error: `Report saved, but could not be finalized for search/audit: ${readyError.message}. Contact support with report id ${report.id}.` };
  }
  await clearDraft("offload");
  await notifyReportSubmission({
    reportType: "offload",
    submittedAt: report.submitted_at ?? new Date().toISOString(),
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: offloadEmailFields(v),
  });
  revalidatePath("/avsec/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at ?? new Date().toISOString(), reportNo: report.report_no ?? undefined };
}

// ---------- Bay Board ----------

export async function addBayBoardEntry(input: {
  station: string;
  reg_no: string;
  aircraft_type?: string;
  bay: string;
  flight?: string;
  on_ground_since: string;
}): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bay_board")
    .insert({
      station: input.station,
      reg_no: input.reg_no.trim().toUpperCase(),
      aircraft_type: input.aircraft_type || null,
      bay: input.bay,
      flight: input.flight?.trim().toUpperCase() || null,
      on_ground_since: input.on_ground_since,
      is_manual: true,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/bay-board");
  return { ok: true, id: data.id };
}

export async function clearBayBoardEntry(id: string): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("bay_board")
    .update({ cleared_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/bay-board");
  return { ok: true };
}
