import { createClient } from "@/lib/supabase/server";
import { getShifts } from "./roster-queries";

const MAX_SHIFT_MINUTES = 20 * 60;

export interface AttendanceRow {
  id: string;
  profile_id: string;
  staff_name: string;
  staff_no: string;
  station: string;
  team: string | null;
  duty_date: string;
  shift_code: string;
  check_in_at: string | null;
  check_out_at: string | null;
  total_minutes: number | null;
  is_missing_checkout: boolean;
  is_off_schedule: boolean;
  is_no_show: boolean;
  scheduled_minutes: number | null;
  ot_minutes: number | null;
  ot_request_id: string | null;
}

export interface AttendanceFilters {
  station?: string;
  team?: string;
  dateFrom: string;
  dateTo: string;
  search?: string;
}

export type AttendanceFlag = "all" | "missing" | "noshow" | "offschedule";

// Shift end can wrap past midnight (Night 2300-0700) — length in minutes, always positive.
function shiftLengthMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const [sh = 0, sm = 0] = start.split(":").map(Number);
  const [eh = 0, em = 0] = end.split(":").map(Number);
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes;
}

export async function getAttendanceRows(filters: AttendanceFilters): Promise<AttendanceRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("duty_records")
    .select(
      "id, profile_id, station, team, duty_date, shift_code, check_in_at, check_out_at, total_minutes, is_missing_checkout, is_off_schedule, status",
    )
    .gte("duty_date", filters.dateFrom)
    .lte("duty_date", filters.dateTo)
    .order("duty_date", { ascending: false });

  if (filters.station) query = query.eq("station", filters.station);
  if (filters.team) query = query.eq("team", filters.team);

  const { data } = await query;
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];

  const profileIds = [...new Set(rows.map((r) => String(r.profile_id)))];

  const [{ data: profiles }, { data: otRequests }, shifts] = await Promise.all([
    supabase.from("profiles").select("id, name, staff_no").in("id", profileIds),
    supabase
      .from("overtime_requests")
      .select("id, profile_id, work_date, payable_hours")
      .in("profile_id", profileIds)
      .gte("work_date", filters.dateFrom)
      .lte("work_date", filters.dateTo)
      .neq("status", "cancelled")
      .neq("status", "rejected"),
    getShifts(),
  ]);

  const profileMap = new Map(
    (profiles ?? []).map((p) => [p.id as string, p as unknown as { name: string; staff_no: string }]),
  );
  const otMap = new Map(
    ((otRequests ?? []) as { id: string; profile_id: string; work_date: string }[]).map((o) => [
      `${o.profile_id}|${o.work_date}`,
      o.id,
    ]),
  );
  const shiftMap = new Map(shifts.map((s) => [s.code, s]));

  let result: AttendanceRow[] = rows.map((r) => {
    const checkIn = r.check_in_at as string | null;
    const checkOut = r.check_out_at as string | null;
    const storedMinutes = r.total_minutes as number | null;
    const totalMinutes =
      storedMinutes ??
      (checkIn && checkOut
        ? Math.min(
            Math.max(Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 60000), 0),
            MAX_SHIFT_MINUTES,
          )
        : null);

    const shift = shiftMap.get(String(r.shift_code));
    const scheduledMinutes = shift ? shiftLengthMinutes(shift.default_start, shift.default_end) : null;
    const otMinutes =
      totalMinutes != null && scheduledMinutes != null && totalMinutes > scheduledMinutes
        ? totalMinutes - scheduledMinutes
        : null;

    const profile = profileMap.get(String(r.profile_id));
    return {
      id: String(r.id),
      profile_id: String(r.profile_id),
      staff_name: profile?.name ?? "Unknown",
      staff_no: profile?.staff_no ?? "",
      station: String(r.station),
      team: (r.team as string | null) ?? null,
      duty_date: String(r.duty_date),
      shift_code: String(r.shift_code),
      check_in_at: checkIn,
      check_out_at: checkOut,
      total_minutes: totalMinutes,
      is_missing_checkout: Boolean(r.is_missing_checkout),
      is_off_schedule: Boolean(r.is_off_schedule),
      is_no_show: r.status === "absent",
      scheduled_minutes: scheduledMinutes,
      ot_minutes: otMinutes,
      ot_request_id: otMap.get(`${r.profile_id}|${r.duty_date}`) ?? null,
    };
  });

  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    result = result.filter(
      (r) => r.staff_name.toLowerCase().includes(q) || r.staff_no.toLowerCase().includes(q),
    );
  }

  return result;
}

export function applyAttendanceFlag(rows: AttendanceRow[], flag: AttendanceFlag): AttendanceRow[] {
  switch (flag) {
    case "missing":
      return rows.filter((r) => r.is_missing_checkout);
    case "noshow":
      return rows.filter((r) => r.is_no_show);
    case "offschedule":
      return rows.filter((r) => r.is_off_schedule);
    default:
      return rows;
  }
}
