// Shared definitions for the SEC016 / Bay Board reconciliation: the exact column sets the CURRENT application writes (lib/avsec/reports/actions.ts,
// submitSec016 / addBayBoardEntry / clearBayBoardEntry), the hosted drift this migration repairs, and payload builders that reproduce the app's inserts.
// tests/sec016-app-payload.test.mts parses actions.ts and fails if these lists ever stop matching the application, so a probe can never silently
// test a different statement than the one the app sends.

/** Keys of the report_sec016 insert in submitSec016(), in the application's order. */
export const SEC016_APP_COLUMNS = [
  "profile_id", "status", "ops_group", "flight_type", "aircraft_search_completed", "search_overdue_flag", "search_remark", "station", "team", "staff_name",
  "staff_no", "duty_date", "duty_hour", "flight", "origin_arr_dep", "assisted_by", "aircraft_type", "aircraft_type_other", "reg_no", "sta_std", "ata_atd",
  "bay_no", "reason_for_delay", "do_infmd", "inbound_baggage", "outbound_baggage", "inbound_cargo", "outbound_cargo", "inbound_co_mail", "outbound_co_mail",
  "shift_leader", "ramp_agents_baggage", "ramp_agents_cargo", "cargo_hold_checked", "staff_frisked", "cabin_check", "discrepancies", "offload_baggage_tag_no",
  "offload_remark",
];

/** bay_board arrival insert in submitSec016(). */
export const BAY_ARRIVAL_COLUMNS = ["station", "reg_no", "aircraft_type", "bay", "flight", "arrival_report_id", "on_ground_since", "is_manual", "created_by"];
/** bay_board departure clear in submitSec016() (the filter columns are station, reg_no, cleared_at). */
export const BAY_DEPARTURE_UPDATE_COLUMNS = ["cleared_at", "cleared_by_report_id", "departure_report_id"];
/** bay_board manual entry in addBayBoardEntry(); manual clear updates only cleared_at. */
export const BAY_MANUAL_COLUMNS = ["station", "reg_no", "aircraft_type", "bay", "flight", "on_ground_since", "is_manual", "created_by"];

/** Columns the hosted staging database lacks on report_sec016 (4 from 20260911000005, 3 from 20260914000001, and the historical ops_group the app still writes as null). */
export const SEC016_NEW_COLUMNS = {
  flight_type: { data_type: "text", nullable: "NO", default: /arrival/ },
  aircraft_search_completed: { data_type: "boolean", nullable: "NO", default: /false/ },
  search_overdue_flag: { data_type: "boolean", nullable: "NO", default: /false/ },
  search_remark: { data_type: "text", nullable: "YES", default: null },
  ramp_agents_baggage: { data_type: "text", nullable: "YES", default: null },
  ramp_agents_cargo: { data_type: "text", nullable: "YES", default: null },
  cabin_check: { data_type: "text", nullable: "YES", default: null },
  ops_group: { data_type: "text", nullable: "YES", default: null },
};
export const BAY_NEW_COLUMNS = {
  flight: { data_type: "text", nullable: "YES", default: null },
  is_manual: { data_type: "boolean", nullable: "NO", default: /false/ },
  arrival_report_id: { data_type: "uuid", nullable: "YES", default: null },
  departure_report_id: { data_type: "uuid", nullable: "YES", default: null },
};

/** The sixteen legacy columns that are NOT NULL on hosted staging although the rev03 application omits them (relaxed by 20260914000001). */
export const SEC016_LEGACY_NULLABLE = [
  "outbound_baggage", "outbound_cargo", "outbound_co_mail", "inbound_baggage", "inbound_cargo", "inbound_co_mail", "ramp_staff_1", "ramp_staff_2", "ramp_staff_3",
  "ramp_staff_4", "ramp_staff_5", "offload_flight_no", "offload_destination", "offload_total_baggage", "offload_baggage_tag_no", "offload_remark",
];
/** Legacy columns the application never sends (their absence from the insert is what failed on hosted with 23502). */
export const SEC016_NEVER_SENT = ["ramp_staff_1", "ramp_staff_2", "ramp_staff_3", "ramp_staff_4", "ramp_staff_5", "offload_flight_no", "offload_destination", "offload_total_baggage"];

/** What the form submits for each direction (Sec016Form.tsx clears the opposite direction's fields). Values are fixture text only. */
export function sec016AppPayload({ profileId, station, team, name, staffNo, reg, flight, flightType, withLegacyValues = false }) {
  const arrival = flightType === "arrival";
  const p = {
    profile_id: profileId, status: "submitted", ops_group: null, flight_type: flightType, aircraft_search_completed: false, search_overdue_flag: false, search_remark: null,
    station, team, staff_name: name, staff_no: staffNo, duty_date: new Date().toISOString().slice(0, 10), duty_hour: "10:00", flight, origin_arr_dep: arrival ? "ARR" : "DEP",
    assisted_by: "fixture", aircraft_type: "A320", aircraft_type_other: null, reg_no: reg, sta_std: "10:00", ata_atd: "10:05", bay_no: "B1", reason_for_delay: null, do_infmd: "NO",
    inbound_baggage: arrival ? "TRL-1" : null, outbound_baggage: arrival ? null : "TRL-2", inbound_cargo: arrival ? "NIL" : null, outbound_cargo: arrival ? null : "NIL",
    inbound_co_mail: arrival ? "NIL" : null, outbound_co_mail: arrival ? null : "NIL", shift_leader: "fixture-sl", ramp_agents_baggage: "RAMP-B1", ramp_agents_cargo: "RAMP-C1",
    cargo_hold_checked: "YES", staff_frisked: "YES", cabin_check: "YES", discrepancies: "none", offload_baggage_tag_no: arrival ? null : "TAG-1", offload_remark: arrival ? null : "none",
  };
  if (withLegacyValues) Object.assign(p, { ramp_staff_1: "RS1", ramp_staff_2: "RS2", offload_flight_no: "AK1", offload_destination: "KUL", offload_total_baggage: "3" });
  return p;
}

/** INSERT text + parameter list for any plain object (column order = key order). */
export function insertSql(table, obj) {
  const keys = Object.keys(obj);
  return { text: `insert into public.${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, values: keys.map((k) => obj[k]) };
}
