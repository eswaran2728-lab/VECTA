"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { hasOpenDutyCheckIn } from "@/lib/duty/checkin-queries";
import { sec016Schema } from "@/lib/schemas/sec016";
import { sec014Schema } from "@/lib/schemas/sec014";
import { sec029Schema } from "@/lib/schemas/sec029";
import { sec018Schema } from "@/lib/schemas/sec018";
import { sec033Schema } from "@/lib/schemas/sec033";
import { sec013Schema } from "@/lib/schemas/sec013";
import { offloadSchema } from "@/lib/schemas/offload";
import { clearDraft } from "@/lib/reports/drafts";
import { notifyReportSubmission } from "@/lib/email/notifyReportSubmission";
import {
  sec016EmailFields,
  sec014EmailFields,
  sec029EmailFields,
  sec018EmailFields,
  sec033EmailFields,
  sec013EmailFields,
  offloadEmailFields,
} from "@/lib/email/reportFields";

export interface ActionResult {
  ok: boolean;
  id?: string;
  submittedAt?: string;
  reportNo?: string;
  error?: string;
}

async function requireProfileId(): Promise<{ id: string; station: string; team: string } | null> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station || !profile.team) return null;
  return { id: profile.id, station: profile.station, team: profile.team };
}

// Reports can only be filed while actually on duty — mirrors the dashboard's compliance
// panel, which already flags a submission from someone who never checked in.
async function ensureCheckedIn(profileId: string): Promise<string | null> {
  const checkedIn = await hasOpenDutyCheckIn(profileId);
  return checkedIn ? null : "You must check in for duty (/duty) before submitting a report.";
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

  const supabase = createClient();
  const { data, error } = await supabase
    .from("report_sec016")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      staff_name: v.staff_name,
      staff_no: v.staff_no,
      duty_date: v.duty_date,
      duty_hour: v.duty_hour,
      flight: v.flight,
      origin_arr_dep: v.origin_arr_dep,
      assisted_by: v.assisted_by,
      aircraft_type: v.aircraft_type,
      aircraft_type_other: v.aircraft_type_other || null,
      reg_no: v.reg_no,
      sta_std: v.sta_std,
      ata_atd: v.ata_atd,
      bay_no: v.bay_no,
      reason_for_delay: v.reason_for_delay || null,
      do_infmd: v.do_infmd,
      inbound_baggage: v.inbound_baggage,
      outbound_baggage: v.outbound_baggage,
      inbound_cargo: v.inbound_cargo,
      outbound_cargo: v.outbound_cargo,
      inbound_co_mail: v.inbound_co_mail,
      outbound_co_mail: v.outbound_co_mail,
      checked_items: v.checked_items,
      shift_leader: v.shift_leader,
      ramp_staff_1: v.ramp_staff_1,
      ramp_staff_2: v.ramp_staff_2,
      ramp_staff_3: v.ramp_staff_3,
      ramp_staff_4: v.ramp_staff_4,
      ramp_staff_5: v.ramp_staff_5,
      cargo_hold_checked: v.cargo_hold_checked,
      staff_frisked: v.staff_frisked,
      discrepancies: v.discrepancies,
      offload_flight_no: v.offload_flight_no,
      offload_destination: v.offload_destination,
      offload_baggage_tag_no: v.offload_baggage_tag_no,
      offload_total_baggage: v.offload_total_baggage,
      offload_remark: v.offload_remark,
    })
    .select("id, submitted_at, report_no")
    .single();

  if (error) return { ok: false, error: error.message };
  await clearDraft("sec016");
  await notifyReportSubmission({
    reportType: "sec016",
    submittedAt: data.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_no,
    fields: sec016EmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: data.id, submittedAt: data.submitted_at, reportNo: data.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("report_sec014")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
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
    if (patrolError) return { ok: false, error: patrolError.message };
  }

  await clearDraft("sec014");
  await notifyReportSubmission({
    reportType: "sec014",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec014EmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("report_sec029")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
      supervising_officer_name: v.supervising_officer_name,
      supervising_officer_id: v.supervising_officer_id,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      assisted_by_name: v.assisted_by_name,
      assisted_by_id: v.assisted_by_id,
      aircraft_type: v.aircraft_type,
      flight_no: v.flight_no,
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
  if (itemError) return { ok: false, error: itemError.message };

  // Clear any open Bay Board entry for this registration at this station.
  await supabase
    .from("bay_board")
    .update({ cleared_by_report_id: report.id, cleared_at: new Date().toISOString() })
    .eq("station", v.station)
    .eq("reg_no", v.aircraft_registration)
    .is("cleared_at", null);

  await clearDraft("sec029");
  await notifyReportSubmission({
    reportType: "sec029",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec029EmailFields(v),
  });
  revalidatePath("/history");
  revalidatePath("/bay-board");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("report_sec018")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
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
    if (patrolError) return { ok: false, error: patrolError.message };
  }

  await clearDraft("sec018");
  await notifyReportSubmission({
    reportType: "sec018",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: "",
    fields: sec018EmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("report_sec033")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
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
  if (holdCheckError) return { ok: false, error: holdCheckError.message };

  await clearDraft("sec033");
  await notifyReportSubmission({
    reportType: "sec033",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec033EmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("report_sec013")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
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
  if (dutyError) return { ok: false, error: dutyError.message };

  await clearDraft("sec013");
  await notifyReportSubmission({
    reportType: "sec013",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: sec013EmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
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

  const supabase = createClient();
  const { data: report, error } = await supabase
    .from("offload_records")
    .insert({
      profile_id: profile.id,
      status: "submitted",
      station: v.station,
      team: v.team,
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
  if (itemsError) return { ok: false, error: itemsError.message };

  await clearDraft("offload");
  await notifyReportSubmission({
    reportType: "offload",
    submittedAt: report.submitted_at,
    submittedByName: v.staff_name,
    submittedByStaffNo: v.staff_id,
    fields: offloadEmailFields(v),
  });
  revalidatePath("/history");
  return { ok: true, id: report.id, submittedAt: report.submitted_at, reportNo: report.report_no ?? undefined };
}

// ---------- Bay Board ----------

export async function addBayBoardEntry(input: {
  station: string;
  reg_no: string;
  aircraft_type?: string;
  bay: string;
  on_ground_since: string;
}): Promise<ActionResult> {
  const profile = await requireProfileId();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = createClient();
  const { data, error } = await supabase
    .from("bay_board")
    .insert({
      station: input.station,
      reg_no: input.reg_no.trim().toUpperCase(),
      aircraft_type: input.aircraft_type || null,
      bay: input.bay,
      on_ground_since: input.on_ground_since,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  revalidatePath("/bay-board");
  return { ok: true, id: data.id };
}
