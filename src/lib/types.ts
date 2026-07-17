import type { AircraftType, ReportType, Station, Team, UserRole } from "./reference-data";

export type ReportStatus = "draft" | "submitted";

export interface Profile {
  id: string;
  email: string;
  name: string;
  staff_no: string;
  station: Station | null;
  team: Team | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface Sec016Row {
  id: string;
  profile_id: string;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  amendment_of: string | null;

  station: string;
  team: string;
  staff_name: string;
  staff_no: string;
  duty_date: string;
  duty_hour: string;

  flight: string;
  origin_arr_dep: string;
  assisted_by: string;
  aircraft_type: string;
  aircraft_type_other: string | null;
  reg_no: string;
  sta_std: string;
  ata_atd: string;
  bay_no: string;
  reason_for_delay: string | null;
  do_infmd: "YES" | "NO";
  inbound_baggage: string;
  outbound_baggage: string;
  inbound_cargo: string;
  outbound_cargo: string;
  inbound_co_mail: string;
  outbound_co_mail: string;
  checked_items: string[];
  shift_leader: string;
  ramp_staff_1: string;
  ramp_staff_2: string;
  ramp_staff_3: string;
  ramp_staff_4: string;
  ramp_staff_5: string;
  cargo_hold_checked: "YES" | "NO";
  staff_frisked: "YES" | "NO";
  discrepancies: string;

  offload_flight_no: string;
  offload_destination: string;
  offload_baggage_tag_no: string;
  offload_total_baggage: string;
  offload_remark: string;
}

export interface Sec014PatrolEntry {
  entry_no: number;
  location: "Aircraft" | "Terminal" | "Premises" | null;
  time_from: string | null;
  time_to: string | null;
  description: string;
}

export interface Sec014Row {
  id: string;
  profile_id: string;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  amendment_of: string | null;

  station: string;
  team: string;
  staff_name: string;
  staff_id: string;
  date_time_in: string;
  date_time_out: string | null;

  remark: string;
  acknowledgement: boolean;

  patrols?: Sec014PatrolEntry[];
}

export interface Sec029ItemEntry {
  item_code: string;
  checked: "YES" | "NO" | "NA";
  remark_type: "nil" | "other" | "na";
  remark_text: string | null;
}

export interface Sec029Row {
  id: string;
  profile_id: string;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  amendment_of: string | null;

  station: string;
  team: string;
  supervising_officer_name: string;
  supervising_officer_id: string;
  staff_name: string;
  staff_id: string;
  assisted_by_name: string;
  assisted_by_id: string;

  aircraft_type: AircraftType;
  flight_no: string;
  aircraft_registration: string;
  std: string;
  parking_bay: string;
  time_commence: string;
  time_completed: string;

  pic_informed: "YES" | "NO";
  declaration: string;
  d_remark: string | null;
  acknowledgement: boolean;

  items?: Sec029ItemEntry[];
}

export interface Sec018PatrolEntry {
  entry_no: number;
  time_from: string | null;
  time_to: string | null;
  parking_bay: string | null;
  aircraft_type: string | null;
  reg_no: string | null;
  description: string;
}

export interface Sec018Row {
  id: string;
  profile_id: string;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  amendment_of: string | null;

  station: string;
  team: string;
  staff_name: string;
  date_time: string;

  acknowledgement: boolean;

  patrols?: Sec018PatrolEntry[];
}

export interface BayBoardRow {
  id: string;
  station: string;
  reg_no: string;
  aircraft_type: string | null;
  bay: string;
  on_ground_since: string;
  cleared_by_report_id: string | null;
  cleared_at: string | null;
  created_by: string;
  created_at: string;
}

export type AnyReportRow = Sec016Row | Sec014Row | Sec029Row | Sec018Row;

export interface ReportListItem {
  id: string;
  type: ReportType;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
  station: string;
  team: string;
  summary: string;
}
