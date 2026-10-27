import { createClient } from "@/lib/supabase/server";
import { getFilteredSubmissions } from "@/lib/avsec/dashboard/queries";
import { getMySubmissions } from "@/lib/avsec/reports/queries";
import {
  buildPersonalActivity,
  buildStationActivity,
  type CheckpointActorRow,
  type CheckpointKind,
  type DutyActorRow,
  type PersonalActivityRow,
  type StationActivityRow,
  type StationDutyRow,
  type StationIncidentRow,
  type StationTransactionRow,
} from "@/lib/avsec/dashboard/activity";

/**
 * Server-side reads for the two landing-page feeds. Authorization is never widened here: every read goes through the caller's own
 * authenticated client, so row-level security stays the authority. The personal feed adds an explicit actor filter in the query itself
 * (profile_id / completed_by = the authenticated user, or the own-scoped submissions RPC) rather than filtering a broad response in
 * the browser, and it never reads the audit log.
 */

const RECENT_DAYS = 7;
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
/** Station codes are short upper-case identifiers; anything else is refused before it can reach a PostgREST filter string. */
const STATION_CODE = /^[A-Z0-9_-]{2,12}$/;

function mytDate(daysAgo = 0): string {
  return new Date(Date.now() + MYT_OFFSET_MS - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type CheckpointTable = { kind: CheckpointKind; table: string; hasResult: boolean; stage?: "B" | "C" };

const CHECKPOINT_SOURCES: readonly CheckpointTable[] = [
  { kind: "part_b", table: "part_b_c", hasResult: true, stage: "B" },
  { kind: "part_c", table: "part_b_c", hasResult: true, stage: "C" },
  { kind: "part_d", table: "caterlink_checkpoint_part_d", hasResult: true },
  { kind: "redq", table: "caterlink_checkpoint_redq", hasResult: false },
  { kind: "receipt", table: "caterlink_checkpoint_hub", hasResult: false },
];

export async function getMyRecentActivity(userId: string): Promise<PersonalActivityRow[]> {
  const supabase = await createClient();
  const since = mytDate(RECENT_DAYS);

  const [dutyRes, submissions, ...checkpointResults] = await Promise.all([
    supabase
      .from("duty_records")
      .select("profile_id, check_in_at, check_out_at")
      .eq("profile_id", userId)
      .gte("duty_date", since)
      .order("check_in_at", { ascending: false })
      .limit(20),
    getMySubmissions({ profileId: userId, limit: 20 }).catch(() => []),
    ...CHECKPOINT_SOURCES.map((src) => {
      let q = supabase
        .from(src.table as never)
        .select(`id, completed_by, completed_at${src.hasResult ? ", result" : ""}, transactions(transaction_number)${src.stage ? ", checkpoint_stage" : ""}` as never)
        .eq("completed_by" as never, userId as never)
        .gte("completed_at" as never, `${since}T00:00:00+08:00` as never);
      if (src.stage) q = q.eq("checkpoint_stage" as never, src.stage as never);
      return q.order("completed_at" as never, { ascending: false }).limit(20);
    }),
  ]);

  const checkpoints: CheckpointActorRow[] = [];
  checkpointResults.forEach((res, i) => {
    const src = CHECKPOINT_SOURCES[i];
    for (const r of ((res as { data: unknown }).data ?? []) as Array<{ id: string; completed_by: string; completed_at: string | null; result?: string | null; transactions: { transaction_number: string } | null }>) {
      checkpoints.push({ kind: src.kind, id: r.id, completed_by: r.completed_by, completed_at: r.completed_at, result: r.result ?? null, transaction_number: r.transactions?.transaction_number ?? null });
    }
  });

  return buildPersonalActivity(userId, {
    duty: (dutyRes.data ?? []) as DutyActorRow[],
    // the own-submissions RPC has no date parameter, so the 7-day window is applied to its (already own-only) rows here
    submissions: submissions
      .filter((s) => s.submitted_at && Date.parse(s.submitted_at) >= Date.parse(`${since}T00:00:00+08:00`))
      .map((s) => ({ id: s.id, type: s.type, submitted_at: s.submitted_at, summary: s.summary, report_no: s.report_no ?? null, status: s.status })),
    checkpoints,
  });
}

/** `station` is the caller's own canonical station, or null for leadership scopes (the existing role-scoped reads then decide the visible set). */
export async function getStationActivity(station: string | null): Promise<StationActivityRow[]> {
  const supabase = await createClient();
  const today = mytDate(0);
  const safeStation = station && STATION_CODE.test(station) ? station : null;
  if (station && !safeStation) return [];

  let stationId: string | null = null;
  if (safeStation) {
    const { data } = await supabase.from("org_stations").select("id").eq("code", safeStation).maybeSingle();
    stationId = (data as { id: string } | null)?.id ?? null;
  }

  let dutyQuery = supabase
    .from("duty_records")
    .select("check_in_at, check_out_at, profiles(name, station)")
    .eq("duty_date", today)
    .order("check_in_at", { ascending: false })
    .limit(20);
  if (safeStation) dutyQuery = dutyQuery.eq("station", safeStation);

  let txQuery = supabase
    .from("transactions")
    .select("transaction_number, status, direction, route, station, hub_destination, created_at, completed_at, origin:org_stations!origin_station_id(code), destination:org_stations!destination_station_id(code)")
    .eq("archived", false)
    .order("created_at", { ascending: false })
    .limit(20);
  if (safeStation) {
    const ors = [`station.eq.${safeStation}`, `hub_destination.eq.${safeStation}`];
    if (stationId) ors.push(`origin_station_id.eq.${stationId}`, `destination_station_id.eq.${stationId}`);
    txQuery = txQuery.or(ors.join(","));
  }

  const [dutyRes, txRes, submissions, incidentsRes] = await Promise.all([
    dutyQuery,
    txQuery,
    getFilteredSubmissions({ dateFrom: today, dateTo: today, ...(safeStation ? { station: safeStation } : {}) }).catch(() => []),
    supabase
      .from("caterlink_incidents" as never)
      .select("id, incident_type, created_at, transactions(transaction_number, station)")
      .in("status", ["OPEN", "UNDER_REVIEW"])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const transactions: StationTransactionRow[] = ((txRes.data ?? []) as unknown as Array<Omit<StationTransactionRow, "origin_station_code" | "destination_station_code"> & { origin: { code: string } | null; destination: { code: string } | null }>).map(
    ({ origin, destination, ...t }) => ({ ...t, origin_station_code: origin?.code ?? null, destination_station_code: destination?.code ?? null }),
  );

  const incidents: StationIncidentRow[] = ((incidentsRes.data ?? []) as unknown as Array<{ id: string; incident_type: string; created_at: string; transactions: { transaction_number: string; station: string | null } | null }>).map((i) => ({
    id: i.id,
    incident_type: i.incident_type,
    created_at: i.created_at,
    transaction_number: i.transactions?.transaction_number ?? null,
    transaction_station: i.transactions?.station ?? null,
  }));

  return buildStationActivity(safeStation, {
    duty: (dutyRes.data ?? []) as unknown as StationDutyRow[],
    transactions,
    submissions: submissions.map((s) => ({ id: s.id, type: s.type, submitted_at: s.submitted_at, summary: s.summary, station: s.station || null, team: s.team || null })),
    incidents,
  });
}
