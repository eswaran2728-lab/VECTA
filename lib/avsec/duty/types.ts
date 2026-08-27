import type { GeoPolygon } from "./geofence";

export interface DutyZone {
  id: string;
  station: string;
  code: string;
  name: string;
  polygon: GeoPolygon;
  center_lat: number;
  center_lng: number;
  radius_m: number;
}

export interface TodayRoster {
  shift_code: string;
  start_time: string | null;
  end_time: string | null;
  zone_id: string | null;
  notes: string | null;
}

export interface DutyRecordRow {
  id: string;
  shift_code: string;
  check_in_at: string | null;
  check_in_inside_fence: boolean | null;
  check_in_accuracy_m: number | null;
  check_out_at: string | null;
  status: string;
  late_minutes: number;
  late_remark: string | null;
  early_out_minutes: number;
  early_out_remark: string | null;
  early_in_minutes: number;
  early_in_remark: string | null;
  late_out_minutes: number;
  late_out_remark: string | null;
}

export interface TimesheetRosterDay {
  roster_date: string;
  shift_code: string;
  start_time: string | null;
  end_time: string | null;
  zone_id: string | null;
}

export interface TimesheetDutyRecord extends DutyRecordRow {
  duty_date: string;
}

export interface DutyRecordDetail {
  id: string;
  profile_id: string;
  station: string;
  team: string | null;
  duty_date: string;
  shift_code: string;
  zone_id: string | null;
  check_in_at: string | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  check_in_accuracy_m: number | null;
  check_in_inside_fence: boolean | null;
  check_in_offline: boolean;
  check_out_at: string | null;
  check_out_lat: number | null;
  check_out_lng: number | null;
  check_out_inside_fence: boolean | null;
  status: string;
  late_minutes: number;
  late_remark: string | null;
  early_out_minutes: number;
  early_out_remark: string | null;
  early_in_minutes: number;
  early_in_remark: string | null;
  late_out_minutes: number;
  late_out_remark: string | null;
  post_assignment: string | null;
  handover_notes: string | null;
}
