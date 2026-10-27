import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";

/**
 * Landing-page activity, split into two honest feeds. Pure (no framework imports) so the actor, timestamp, scope and label rules are
 * unit-testable; the Supabase reads live in activity-queries.ts.
 *
 *  - My recent activity: only things the SIGNED-IN officer did. The actor comes from stored actor columns (duty_records.profile_id,
 *    <checkpoint>.completed_by, the secure own-submissions RPC) compared with the authenticated user id, never from visibility.
 *  - Station activity: operational records the role may read at the officer's own station, shown as a snapshot of what the page loaded.
 */

export interface PersonalActivityRow {
  key: string;
  /** The action's own timestamp (check-in time, submission time, checkpoint completion time). */
  time: string;
  /** What the officer did, in the first person of the record ("Checked in", "Submitted AA/SEC/F/014 Rev.03 ..."). */
  activity: string;
  /** Movement number or report number when the action has one. */
  reference: string | null;
  status: string;
}

export interface DutyActorRow {
  profile_id: string;
  check_in_at: string | null;
  check_out_at: string | null;
}

export interface SubmissionRow {
  id: string;
  type: ReportType;
  submitted_at: string | null;
  summary: string;
  report_no?: string | null;
  status: string;
}

export type CheckpointKind = "part_b" | "part_c" | "part_d" | "redq" | "receipt";

export interface CheckpointActorRow {
  kind: CheckpointKind;
  id: string;
  completed_by: string;
  completed_at: string | null;
  /** PASS / ESCALATE where the checkpoint records one. */
  result?: string | null;
  transaction_number: string | null;
}

const CHECKPOINT_LABEL: Record<CheckpointKind, string> = {
  part_b: "Origin checkpoint (Part B)",
  part_c: "Checkpoint (Part C)",
  part_d: "Delivery checkpoint (Part D)",
  redq: "REDQ reseal checkpoint",
  receipt: "Confirmed destination receipt",
};

export const PERSONAL_ACTIVITY_LIMIT = 20;

/**
 * Rows are filtered by the actor again here (defence in depth behind the server-side `.eq(actor, userId)` / own-scoped RPC), so a
 * broad or mis-scoped input can never surface somebody else's action as the officer's own.
 */
export function buildPersonalActivity(
  userId: string,
  input: { duty: readonly DutyActorRow[]; submissions: readonly SubmissionRow[]; checkpoints: readonly CheckpointActorRow[] },
  limit = PERSONAL_ACTIVITY_LIMIT,
): PersonalActivityRow[] {
  const rows: PersonalActivityRow[] = [];

  for (const d of input.duty) {
    if (d.profile_id !== userId) continue;
    if (d.check_in_at) rows.push({ key: `duty-in-${d.check_in_at}`, time: d.check_in_at, activity: "Checked in for duty", reference: null, status: "DUTY" });
    if (d.check_out_at) rows.push({ key: `duty-out-${d.check_out_at}`, time: d.check_out_at, activity: "Checked out of duty", reference: null, status: "DUTY" });
  }

  for (const s of input.submissions) {
    if (s.status !== "submitted" || !s.submitted_at) continue;
    rows.push({
      key: `report-${s.type}-${s.id}`,
      time: s.submitted_at,
      activity: `Submitted ${REPORT_META[s.type].code}${s.summary ? ` — ${s.summary}` : ""}`,
      reference: s.report_no ?? null,
      status: "SUBMITTED",
    });
  }

  for (const c of input.checkpoints) {
    if (c.completed_by !== userId || !c.completed_at) continue;
    const escalated = c.result === "ESCALATE";
    rows.push({
      key: `cp-${c.kind}-${c.id}`,
      time: c.completed_at,
      activity: `${CHECKPOINT_LABEL[c.kind]}${escalated ? " — escalated" : ""}`,
      reference: c.transaction_number,
      status: escalated ? "ESCALATED" : "RECORDED",
    });
  }

  rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return rows.slice(0, limit);
}

export interface StationActivityRow {
  key: string;
  time: string;
  activity: string;
  /** Movement route (HUB / AIRCRAFT / REDQ / MAINTENANCE). Only movement rows have one. */
  route: string | null;
  /** A real station code, only when the record itself provides one. */
  location: string | null;
  status: string;
  transactionStatus?: string;
}

export interface StationDutyRow {
  check_in_at: string | null;
  check_out_at: string | null;
  profiles: { name: string; station: string | null } | null;
}

export interface StationTransactionRow {
  transaction_number: string;
  status: string;
  direction: string;
  route: string;
  station: string | null;
  hub_destination: string | null;
  origin_station_code: string | null;
  destination_station_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface StationSubmissionRow {
  id: string;
  type: ReportType;
  submitted_at: string | null;
  summary: string;
  station: string | null;
  team: string | null;
}

export interface StationIncidentRow {
  id: string;
  incident_type: string;
  created_at: string;
  transaction_number: string | null;
  transaction_station: string | null;
}

export const STATION_ACTIVITY_LIMIT = 20;

/** The station codes a movement touches: where it was created, where it goes, and its origin and destination stations. */
export function transactionStations(t: Pick<StationTransactionRow, "station" | "hub_destination" | "origin_station_code" | "destination_station_code">): string[] {
  return [t.station, t.hub_destination, t.origin_station_code, t.destination_station_code].filter((v): v is string => !!v);
}

/**
 * `station` null means a leadership scope (the existing role-scoped reads already decide what is visible); a station code restricts every
 * record type to that station so another station's records never mix in.
 */
export function buildStationActivity(
  station: string | null,
  input: {
    duty: readonly StationDutyRow[];
    transactions: readonly StationTransactionRow[];
    submissions: readonly StationSubmissionRow[];
    incidents: readonly StationIncidentRow[];
  },
  limit = STATION_ACTIVITY_LIMIT,
): StationActivityRow[] {
  const rows: StationActivityRow[] = [];

  for (const d of input.duty) {
    const dutyStation = d.profiles?.station ?? null;
    if (station && dutyStation !== station) continue;
    const name = d.profiles?.name ?? "Officer";
    if (d.check_out_at) rows.push({ key: `duty-out-${d.check_out_at}-${name}`, time: d.check_out_at, activity: `${name} checked out`, route: null, location: dutyStation, status: "CHECKED OUT" });
    if (d.check_in_at) rows.push({ key: `duty-in-${d.check_in_at}-${name}`, time: d.check_in_at, activity: `${name} checked in`, route: null, location: dutyStation, status: d.check_out_at ? "CHECKED IN" : "ON DUTY" });
  }

  for (const t of input.transactions) {
    if (station && !transactionStations(t).includes(station)) continue;
    const time = t.completed_at ?? t.created_at;
    rows.push({
      key: `tx-${t.transaction_number}-${time}`,
      time,
      activity: `${t.transaction_number} · ${t.direction === "OUTBOUND" ? "Outbound" : t.direction === "INBOUND" ? "Inbound" : t.direction.replace(/_/g, " ").toLowerCase()} movement ${t.completed_at ? "completed" : "created"}`,
      route: t.route,
      location: t.station,
      status: t.status,
      transactionStatus: t.status,
    });
  }

  for (const s of input.submissions) {
    if (!s.submitted_at) continue;
    if (station && s.station !== station) continue;
    rows.push({
      key: `report-${s.type}-${s.id}`,
      time: s.submitted_at,
      activity: `${REPORT_META[s.type].code} submitted${s.summary ? ` — ${s.summary}` : ""}`,
      route: null,
      location: s.station,
      status: "SUBMITTED",
    });
  }

  for (const inc of input.incidents) {
    if (station && inc.transaction_station !== station) continue;
    rows.push({
      key: `incident-${inc.id}`,
      time: inc.created_at,
      activity: `Incident — ${inc.incident_type}${inc.transaction_number ? ` (${inc.transaction_number})` : ""}`,
      route: null,
      location: inc.transaction_station,
      status: "OPEN",
    });
  }

  rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return rows.slice(0, limit);
}
