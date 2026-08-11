// Maps each report's validated submission data to the ordered {label, value} list used
// in the admin notification email — labels mirror what's shown on the form itself.

import type { Sec016FormValues } from "@/lib/schemas/sec016";
import type { Sec014FormValues } from "@/lib/schemas/sec014";
import type { Sec029FormValues } from "@/lib/schemas/sec029";
import type { Sec018FormValues } from "@/lib/schemas/sec018";
import type { Sec033FormValues } from "@/lib/schemas/sec033";
import { SEC029_ITEMS } from "@/lib/reference-data";
import type { EmailField } from "./reportEmailTemplate";

export function sec016EmailFields(v: Sec016FormValues): EmailField[] {
  return [
    { label: "Station", value: v.station },
    { label: "Team", value: v.team },
    { label: "Name", value: v.staff_name },
    { label: "Staff No", value: v.staff_no },
    { label: "Date", value: v.duty_date },
    { label: "Duty Hour", value: v.duty_hour },
    { label: "Flight", value: v.flight },
    { label: "Origin Arr / Dep", value: v.origin_arr_dep },
    { label: "Assisted By", value: v.assisted_by },
    { label: "Aircraft Type", value: v.aircraft_type === "Other" ? v.aircraft_type_other : v.aircraft_type },
    { label: "Reg No", value: v.reg_no },
    { label: "STA / STD", value: v.sta_std },
    { label: "ATA / ATD", value: v.ata_atd },
    { label: "Bay No", value: v.bay_no },
    { label: "Reason for Delay", value: v.reason_for_delay },
    { label: "D/O INFMD", value: v.do_infmd },
    { label: "Inbound Baggage", value: v.inbound_baggage },
    { label: "Outbound Baggage", value: v.outbound_baggage },
    { label: "Inbound Cargo", value: v.inbound_cargo },
    { label: "Outbound Cargo", value: v.outbound_cargo },
    { label: "Inbound Co-Mail / Comart", value: v.inbound_co_mail },
    { label: "Outbound Co-Mail / Comart", value: v.outbound_co_mail },
    { label: "Checked", value: v.checked_items.join(", ") },
    { label: "Shift Leader", value: v.shift_leader },
    { label: "Ramp Staff 1", value: v.ramp_staff_1 },
    { label: "Ramp Staff 2", value: v.ramp_staff_2 },
    { label: "Ramp Staff 3", value: v.ramp_staff_3 },
    { label: "Ramp Staff 4", value: v.ramp_staff_4 },
    { label: "Ramp Staff 5", value: v.ramp_staff_5 },
    { label: "Cargo Hold Checked", value: v.cargo_hold_checked },
    { label: "Staff Frisked", value: v.staff_frisked },
    { label: "Discrepancies", value: v.discrepancies },
    { label: "Offload Flight No", value: v.offload_flight_no },
    { label: "Offload Destination", value: v.offload_destination },
    { label: "Offload Baggage Tag No", value: v.offload_baggage_tag_no },
    { label: "Offload Total Baggage", value: v.offload_total_baggage },
    { label: "Offload Remark", value: v.offload_remark },
  ];
}

export function sec014EmailFields(v: Sec014FormValues): EmailField[] {
  const patrolFields = v.patrols.map((p, idx) => ({
    label: `Patrol ${idx + 1}`,
    value: `${p.location ?? "—"} (${p.time_from ?? "—"}–${p.time_to ?? "—"}): ${p.description}`,
  }));
  return [
    { label: "Station", value: v.station },
    { label: "Team", value: v.team },
    { label: "Name", value: v.staff_name },
    { label: "Staff ID", value: v.staff_id },
    { label: "Date & Time In", value: v.date_time_in },
    { label: "Date & Time Out", value: v.date_time_out },
    ...patrolFields,
    { label: "Issue(s) / Event(s) / Equipment(s)", value: v.remark },
  ];
}

export function sec029EmailFields(v: Sec029FormValues): EmailField[] {
  const itemFields = v.items.map((item) => {
    const meta = SEC029_ITEMS.find((i) => i.code === item.item_code);
    const remark = item.remark_type === "other" ? item.remark_text : item.remark_type === "na" ? "N/A" : "Nil";
    return { label: meta?.label ?? item.item_code, value: `${item.checked} — ${remark}` };
  });
  return [
    { label: "Station", value: v.station },
    { label: "Team", value: v.team },
    { label: "Supervising Officer Name", value: v.supervising_officer_name },
    { label: "Supervising Officer ID Number", value: v.supervising_officer_id },
    { label: "Staff Name", value: v.staff_name },
    { label: "Staff ID", value: v.staff_id },
    { label: "Assisted By (Name)", value: v.assisted_by_name },
    { label: "Assisted By (ID Number)", value: v.assisted_by_id },
    { label: "Aircraft Type", value: v.aircraft_type },
    { label: "Flight No", value: v.flight_no },
    { label: "Aircraft Registration", value: v.aircraft_registration },
    { label: "STD", value: v.std },
    { label: "Parking Bay", value: v.parking_bay },
    { label: "Time Commence", value: v.time_commence },
    { label: "Time Completed", value: v.time_completed },
    ...itemFields,
    { label: "Information to PIC", value: v.pic_informed },
    { label: "Declaration", value: v.declaration },
    { label: "Remark / Detection", value: v.d_remark ?? "" },
  ];
}

export function sec018EmailFields(v: Sec018FormValues): EmailField[] {
  const patrolFields = v.patrols.map((p, idx) => ({
    label: `Patrol ${idx + 1}`,
    value: `${p.time_from ?? "—"}–${p.time_to ?? "—"} · Bay ${p.parking_bay ?? "—"} · ${p.aircraft_type ?? "—"} · ${p.reg_no ?? "—"}: ${p.description}`,
  }));
  return [
    { label: "Station", value: v.station },
    { label: "Team", value: v.team },
    { label: "Name", value: v.staff_name },
    { label: "Date & Time", value: v.date_time },
    ...patrolFields,
  ];
}

export function sec033EmailFields(v: Sec033FormValues): EmailField[] {
  const holdCheckFields = v.hold_checks.map((h, idx) => ({
    label: `Hold Check ${idx + 1}`,
    value: `Bay ${h.parking_bay_no} · Reg ${h.aircraft_registration_no}${h.remarks ? ` — ${h.remarks}` : ""}`,
  }));
  return [
    { label: "Station", value: v.station },
    { label: "Team", value: v.team },
    { label: "Name", value: v.staff_name },
    { label: "Staff ID", value: v.staff_id },
    { label: "Date", value: v.report_date },
    { label: "Time", value: v.report_time },
    ...holdCheckFields,
  ];
}
