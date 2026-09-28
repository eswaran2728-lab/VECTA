import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Flight matching across SEC016 / SEC029 / CaterLink transactions.
 *
 * report_sec016 has a real duty_date column; transactions and report_sec029
 * only have timestamps, so their "date" is the Asia/Kuala_Lumpur calendar
 * date of created_at/submitted_at. Flight numbers repeat across different
 * days/routes, so every match here is flight number + calendar date +
 * station together, never flight number alone.
 */

function myDateOf(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function normFlight(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

export interface FlightSummary {
  flight: string;
  date: string;
  station: string;
  regNo: string | null;
}

/** Atomic secure fetch: search_reports_secure() (Phase 6) authorizes via
 * has_report_access() AND returns the full source row (as `content`) in
 * the SAME database call for report_sec016/report_sec029 on the given
 * date. No follow-up query against any report source table -- direct
 * SELECT on these tables is closed at the RLS layer (Phase 6 Part O) for
 * anyone but the row's own submitter. Returns an empty set until the
 * report is indexed into the repository -- expected fail-closed behavior
 * until the Phase 5/6 rollout runs, not a bug. CaterLink `transactions`
 * below is a separate, pre-existing domain, untouched by this. */
async function authorizedContentForDate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sourceTable: "report_sec016" | "report_sec029",
  date: string,
): Promise<Record<string, unknown>[]> {
  const { data } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: date,
    p_to_date: date,
  });
  return (data ?? []).filter((r) => r.source_table === sourceTable && r.content).map((r) => r.content as Record<string, unknown>);
}

export async function getFlightsForDate(date: string, station?: string): Promise<FlightSummary[]> {
  const supabase = await createClient();

  const sec016Rows = (await authorizedContentForDate(supabase, "report_sec016", date)).filter(
    (row) => row.duty_date === date && row.status === "submitted" && row.flight && (!station || row.station === station),
  );

  let txQ = supabase
    .from("transactions")
    .select("flight_number, station, aircraft_registration, created_at")
    .eq("archived", false)
    .not("flight_number", "is", null)
    .gte("created_at", `${date}T00:00:00+08:00`)
    .lte("created_at", `${date}T23:59:59+08:00`);
  if (station) txQ = txQ.eq("station", station);

  const { data: txRows } = await txQ;

  const map = new Map<string, FlightSummary>();
  for (const r of sec016Rows) {
    const flight = r.flight as string;
    const rowStation = r.station as string;
    if (!flight || !rowStation) continue;
    map.set(`${normFlight(flight)}|${rowStation}`, {
      flight,
      date,
      station: rowStation,
      regNo: (r.reg_no as string | null) ?? null,
    });
  }
  for (const t of txRows ?? []) {
    if (!t.flight_number || !t.station) continue;
    if (myDateOf(t.created_at) !== date) continue;
    const key = `${normFlight(t.flight_number)}|${t.station}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.regNo && t.aircraft_registration) existing.regNo = t.aircraft_registration;
    } else {
      map.set(key, { flight: t.flight_number, date, station: t.station, regNo: t.aircraft_registration });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.flight.localeCompare(b.flight) || a.station.localeCompare(b.station));
}

export interface AssignedOfficer {
  name: string;
  staffId: string | null;
  role: string;
}

export interface FlightDetail {
  flight: string;
  date: string;
  station: string;
  sec016Reports: { id: string; flightType: string | null; regNo: string | null; submittedAt: string | null }[];
  sec029Reports: { id: string; regNo: string | null; declaration: string | null; submittedAt: string | null }[];
  transactions: {
    id: string;
    transactionNumber: string;
    status: string;
    direction: string | null;
    driverName: string | null;
    createdAt: string;
  }[];
  incidents: { id: string; incidentType: string; status: string; createdAt: string; transactionNumber: string | null }[];
  officers: AssignedOfficer[];
}

export async function getFlightDetail(flight: string, date: string, station: string): Promise<FlightDetail> {
  const supabase = await createClient();
  const flightNorm = normFlight(flight);

  const [sec016Content, sec029Content] = await Promise.all([
    authorizedContentForDate(supabase, "report_sec016", date),
    authorizedContentForDate(supabase, "report_sec029", date),
  ]);
  const sec016Rows = sec016Content.filter((r) => r.duty_date === date && r.station === station && r.status === "submitted") as unknown as {
    id: string; flight: string | null; flight_type: string | null; reg_no: string | null; submitted_at: string | null;
    staff_name: string | null; staff_no: string | null; assisted_by: string | null; shift_leader: string | null;
  }[];
  const sec029Rows = sec029Content.filter((r) => r.station === station && r.status === "submitted") as unknown as {
    id: string; flight_no: string | null; aircraft_registration: string | null; declaration: string | null;
    submitted_at: string | null; staff_name: string | null; supervising_officer_name: string | null;
  }[];

  const [{ data: txRows }] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, transaction_number, status, direction, driver_name, escort_officer_name, created_at")
      .eq("archived", false)
      .eq("station", station)
      .not("flight_number", "is", null),
  ]);

  const sec016 = (sec016Rows ?? []).filter((r) => r.flight && normFlight(r.flight) === flightNorm);
  const sec029 = (sec029Rows ?? []).filter(
    (r) => r.flight_no && normFlight(r.flight_no) === flightNorm && myDateOf(r.submitted_at) === date
  );
  const flightTx = (txRows ?? []).filter(
    (t) => (t as unknown as { flight_number: string | null }).flight_number
  ) as unknown as { id: string; transaction_number: string; status: string; direction: string | null; driver_name: string | null; escort_officer_name: string | null; created_at: string; flight_number: string }[];
  const matchedTx = flightTx.filter((t) => normFlight(t.flight_number) === flightNorm && myDateOf(t.created_at) === date);

  const txIds = matchedTx.map((t) => t.id);
  const { data: incidentRows } =
    txIds.length > 0
      ? await supabase
          .from("incidents")
          .select("id, incident_type, status, created_at, transaction_id, transactions(transaction_number)")
          .in("transaction_id", txIds)
      : { data: [] };

  const officers: AssignedOfficer[] = [];
  for (const r of sec016) {
    if (r.staff_name) officers.push({ name: r.staff_name, staffId: r.staff_no, role: "ASO (SEC016)" });
    if (r.assisted_by) officers.push({ name: r.assisted_by, staffId: null, role: "Assisted by (SEC016)" });
    if (r.shift_leader) officers.push({ name: r.shift_leader, staffId: null, role: "Ramp Loading Supervisor" });
  }
  for (const r of sec029) {
    if (r.staff_name) officers.push({ name: r.staff_name, staffId: null, role: "ASO (SEC029 search)" });
    if (r.supervising_officer_name) officers.push({ name: r.supervising_officer_name, staffId: null, role: "Supervising Officer (SEC029)" });
  }
  for (const t of matchedTx) {
    if (t.driver_name) officers.push({ name: t.driver_name, staffId: null, role: "CaterLink Driver" });
    if (t.escort_officer_name) officers.push({ name: t.escort_officer_name, staffId: null, role: "Escort Officer" });
  }
  // De-dupe by name+role.
  const seen = new Set<string>();
  const dedupedOfficers = officers.filter((o) => {
    const key = `${o.name}|${o.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    flight,
    date,
    station,
    sec016Reports: sec016.map((r) => ({
      id: r.id,
      flightType: r.flight_type,
      regNo: r.reg_no,
      submittedAt: r.submitted_at,
    })),
    sec029Reports: sec029.map((r) => ({
      id: r.id,
      regNo: r.aircraft_registration,
      declaration: r.declaration,
      submittedAt: r.submitted_at,
    })),
    transactions: matchedTx.map((t) => ({
      id: t.id,
      transactionNumber: t.transaction_number,
      status: t.status,
      direction: t.direction,
      driverName: t.driver_name,
      createdAt: t.created_at,
    })),
    incidents: ((incidentRows ?? []) as unknown as {
      id: string;
      incident_type: string;
      status: string;
      created_at: string;
      transactions: { transaction_number: string } | null;
    }[]).map((i) => ({
      id: i.id,
      incidentType: i.incident_type,
      status: i.status,
      createdAt: i.created_at,
      transactionNumber: i.transactions?.transaction_number ?? null,
    })),
    officers: dedupedOfficers,
  };
}

export interface RegistrationMovement {
  source: "sec016" | "sec029" | "transaction";
  id: string;
  flight: string | null;
  date: string;
  station: string;
  summary: string;
}

/** Recent movements for a specific physical aircraft, across flights/days.
 * The report-content half (SEC016/SEC029) is fully atomic: search_movements_
 * by_registration_secure() (Phase 6) authorizes each candidate row via
 * has_report_access() AND resolves/matches its registration internally
 * (report_source_content(), never a follow-up query), bounded to the last
 * 30 days by default with a hard result cap -- never an unrestricted
 * historical scan. CaterLink `transactions` is a separate, pre-existing
 * domain with its own RLS, untouched and queried directly as before. */
export async function getMovementsByRegistration(reg: string, limit = 50): Promise<RegistrationMovement[]> {
  const supabase = await createClient();
  const regTrim = reg.trim().toUpperCase();

  const [{ data: reportMovements }, { data: txRows }] = await Promise.all([
    supabase.rpc("search_movements_by_registration_secure", {
      p_registration: regTrim,
      p_max_results: limit,
    }),
    supabase
      .from("transactions")
      .select("id, flight_number, station, created_at, aircraft_registration")
      .ilike("aircraft_registration", regTrim)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  const movements: RegistrationMovement[] = [];
  for (const m of reportMovements ?? []) {
    movements.push({
      source: m.source === "report_sec016" ? "sec016" : "sec029",
      id: m.id,
      flight: m.flight,
      date: m.report_date ?? "",
      station: m.station ?? "",
      summary: m.summary,
    });
  }
  for (const t of txRows ?? []) {
    const date = myDateOf(t.created_at);
    movements.push({
      source: "transaction",
      id: t.id,
      flight: t.flight_number,
      date,
      station: t.station ?? "",
      summary: `CaterLink · ${t.flight_number ?? "—"} · ${date}`,
    });
  }
  return movements.sort((a, b) => b.date.localeCompare(a.date));
}
