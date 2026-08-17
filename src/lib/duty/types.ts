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
}
