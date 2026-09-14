import { createClient } from "@/lib/supabase/server";
import { LEAVE_TYPE_LABELS, type LeaveType } from "@/lib/avsec/duty/absence-logic";
import {
  computePeriodDateRange,
  type PeriodType,
  type MergedAttendanceFilter,
} from "./merged-attendance-logic";

export { computePeriodDateRange, type PeriodType, type MergedAttendanceFilter };

export interface MergedDailyRecord {
  date: string;
  profileId: string;
  staffName: string;
  staffNo: string;
  station: string;
  team: string | null;
  scheduledShift: {
    code: string;
    startTime: string | null;
    endTime: string | null;
  } | null;
  dutyRecord: {
    id: string;
    checkInAt: string | null;
    checkOutAt: string | null;
    totalMinutes: number | null;
    status: string;
    isMissingCheckout: boolean;
  } | null;
  leave: {
    id: string;
    leaveType: LeaveType | string;
    leaveLabel: string;
    approvalStatus: "pending" | "approved" | "rejected" | "cancelled" | "cancellation_requested";
    isApproved: boolean;
    startDate: string;
    endDate: string;
  } | null;
  overtime: {
    id: string;
    payableHours: number;
    totalHours: number;
    status: "pending" | "endorsed" | "approved" | "rejected" | "cancelled";
    isApproved: boolean;
    reason: string;
    startAt: string;
    endAt: string;
  } | null;
}

export interface StaffMergedSummary {
  profileId: string;
  staffName: string;
  staffNo: string;
  station: string;
  team: string | null;
  role: string;
  totalShiftsWorked: number;
  totalHoursWorked: number; // in hours
  totalApprovedOtHours: number;
  totalPendingOtHours: number;
  leavesTaken: Array<{
    leaveType: string;
    leaveLabel: string;
    daysCount: number;
    dateRanges: string[];
  }>;
  dailyEntries: MergedDailyRecord[];
}

export interface MergedAttendanceDataResult {
  periodType: PeriodType;
  selectedDate: string;
  selectedMonth: string;
  selectedYear: string;
  dateFrom: string;
  dateTo: string;
  dateList: string[];
  summaries: StaffMergedSummary[];
  allDailyRecords: MergedDailyRecord[];
  pagination: {
    page: number;
    pageSize: number;
    totalProfiles: number;
    totalPages: number;
  };
  totals: {
    totalStaff: number;
    totalShiftsWorked: number;
    totalHoursWorked: number;
    totalApprovedOtHours: number;
    totalPendingOtCount: number;
    totalLeaveDaysTaken: number;
  };
}


export async function getMergedAttendanceData(
  filters: MergedAttendanceFilter
): Promise<MergedAttendanceDataResult> {
  const {
    periodType,
    selectedDate,
    selectedMonth,
    selectedYear,
    dateFrom,
    dateTo,
    dateList,
  } = computePeriodDateRange(filters);

  const supabase = await createClient();

  // 1. Fetch Profiles
  let profileQuery = supabase
    .from("profiles")
    .select("id, name, staff_no, station, team, role")
    .order("name", { ascending: true });

  if (filters.station) profileQuery = profileQuery.eq("station", filters.station);
  if (filters.team) profileQuery = profileQuery.eq("team", filters.team);

  const { data: rawProfiles } = await profileQuery;
  let profiles = (rawProfiles ?? []) as Array<{
    id: string;
    name: string;
    staff_no: string;
    station: string;
    team: string | null;
    role: string;
  }>;

  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    profiles = profiles.filter(
      (p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.staff_no && p.staff_no.toLowerCase().includes(q))
    );
  }

  const totalProfiles = profiles.length;
  const page = Math.max(1, Number(filters.page) || 1);
  const defaultPageSize = periodType === "year" ? 25 : 50;
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || defaultPageSize));
  const totalPages = Math.max(1, Math.ceil(totalProfiles / pageSize));

  // If no profiles match, return empty totals
  if (totalProfiles === 0) {
    return {
      periodType,
      selectedDate,
      selectedMonth,
      selectedYear,
      dateFrom,
      dateTo,
      dateList,
      summaries: [],
      allDailyRecords: [],
      pagination: {
        page: 1,
        pageSize,
        totalProfiles: 0,
        totalPages: 1,
      },
      totals: {
        totalStaff: 0,
        totalShiftsWorked: 0,
        totalHoursWorked: 0,
        totalApprovedOtHours: 0,
        totalPendingOtCount: 0,
        totalLeaveDaysTaken: 0,
      },
    };
  }

  // Slice profiles for the requested page to bound DB payload and query time
  const paginatedProfiles = profiles.slice((page - 1) * pageSize, page * pageSize);
  const profileIds = paginatedProfiles.map((p) => p.id);

  // 2. Fetch parallel data: Rosters, Duty Records, Absence/Leaves, Overtime Records
  const [
    { data: rosterData },
    { data: dutyData },
    { data: leaveData },
    { data: otData },
  ] = await Promise.all([
    // Rosters
    supabase
      .from("team_rosters")
      .select("station, team, roster_date, shift_code, start_time, end_time")
      .gte("roster_date", dateFrom)
      .lte("roster_date", dateTo),

    // Duty Records
    supabase
      .from("duty_records")
      .select("id, profile_id, station, team, duty_date, shift_code, check_in_at, check_out_at, total_minutes, status, is_missing_checkout")
      .in("profile_id", profileIds)
      .gte("duty_date", dateFrom)
      .lte("duty_date", dateTo),

    // Absence / Leave Notices (approved and pending)
    supabase
      .from("absence_notices")
      .select("id, user_id, staff_name, staff_id, station, team, leave_type, start_date, end_date, approval_status")
      .in("user_id", profileIds)
      .lte("start_date", dateTo)
      .gte("end_date", dateFrom),

    // Overtime Requests
    supabase
      .from("overtime_requests")
      .select("id, profile_id, station, team, work_date, shift_code, start_at, end_at, hours, payable_hours, status, reason, linked_duty_id")
      .in("profile_id", profileIds)
      .gte("work_date", dateFrom)
      .lte("work_date", dateTo),
  ]);

  // Index Rosters by station|team|date
  const rosterMap = new Map<string, { shift_code: string; start_time: string | null; end_time: string | null }>();
  for (const r of rosterData ?? []) {
    rosterMap.set(`${r.station}|${r.team || ""}|${r.roster_date}`, {
      shift_code: r.shift_code,
      start_time: r.start_time,
      end_time: r.end_time,
    });
  }

  // Index Duty records by profileId|duty_date
  const dutyMap = new Map<string, Record<string, unknown>>();
  for (const d of dutyData ?? []) {
    dutyMap.set(`${d.profile_id}|${d.duty_date}`, d as Record<string, unknown>);
  }

  // Index Leave notices by profileId and date overlap
  const leavesByProfile = new Map<string, Array<Record<string, unknown>>>();
  for (const l of leaveData ?? []) {
    const list = leavesByProfile.get(l.user_id) || [];
    list.push(l as Record<string, unknown>);
    leavesByProfile.set(l.user_id, list);
  }

  // Index Overtime by profileId|work_date
  const otMap = new Map<string, Record<string, unknown>>();
  for (const o of otData ?? []) {
    otMap.set(`${o.profile_id}|${o.work_date}`, o as Record<string, unknown>);
  }

  // 3. Build Merged Daily Records and Summaries
  const allDailyRecords: MergedDailyRecord[] = [];
  const summaries: StaffMergedSummary[] = [];

  let overallShiftsWorked = 0;
  let overallTotalMinutes = 0;
  let overallApprovedOtHours = 0;
  let overallPendingOtCount = 0;
  let overallLeaveDays = 0;

  for (const profile of paginatedProfiles) {
    let staffShiftsWorked = 0;
    let staffTotalMinutes = 0;
    let staffApprovedOtHours = 0;
    let staffPendingOtHours = 0;
    const staffDailyEntries: MergedDailyRecord[] = [];
    const staffLeaveBreakdown = new Map<string, { label: string; count: number; ranges: Set<string> }>();

    const userLeaves = leavesByProfile.get(profile.id) || [];

    for (const dStr of dateList) {
      // Check roster
      const rosterKey = `${profile.station}|${profile.team || ""}|${dStr}`;
      const rosterItem = rosterMap.get(rosterKey);

      // Check duty
      const dutyKey = `${profile.id}|${dStr}`;
      const dutyItem = dutyMap.get(dutyKey);

      // Check leave
      const matchingLeave = userLeaves.find(
        (l) => (l.start_date as string) <= dStr && (l.end_date as string) >= dStr
      );

      // Check overtime
      const otKey = `${profile.id}|${dStr}`;
      const otItem = otMap.get(otKey);

      // Calculate duty statistics
      let dutyRecordObj: MergedDailyRecord["dutyRecord"] = null;
      if (dutyItem) {
        const totalMinutes = dutyItem.total_minutes != null ? Number(dutyItem.total_minutes) : null;
        dutyRecordObj = {
          id: String(dutyItem.id),
          checkInAt: (dutyItem.check_in_at as string) || null,
          checkOutAt: (dutyItem.check_out_at as string) || null,
          totalMinutes,
          status: String(dutyItem.status || "completed"),
          isMissingCheckout: Boolean(dutyItem.is_missing_checkout),
        };

        if (dutyItem.check_in_at || dutyItem.status === "completed" || dutyItem.status === "present") {
          staffShiftsWorked += 1;
        }
        if (totalMinutes && totalMinutes > 0) {
          staffTotalMinutes += totalMinutes;
        }
      }

      // Leave object
      let leaveObj: MergedDailyRecord["leave"] = null;
      if (matchingLeave) {
        const lType = String(matchingLeave.leave_type) as LeaveType;
        const lLabel = LEAVE_TYPE_LABELS[lType] || lType;
        const appStatus = matchingLeave.approval_status as NonNullable<MergedDailyRecord["leave"]>["approvalStatus"];
        const isApp = appStatus === "approved";

        leaveObj = {
          id: String(matchingLeave.id),
          leaveType: lType,
          leaveLabel: lLabel,
          approvalStatus: appStatus,
          isApproved: isApp,
          startDate: String(matchingLeave.start_date),
          endDate: String(matchingLeave.end_date),
        };

        if (isApp) {
          const prev = staffLeaveBreakdown.get(lType) || { label: lLabel, count: 0, ranges: new Set() };
          prev.count += 1;
          const rangeStr = matchingLeave.start_date === matchingLeave.end_date
            ? String(matchingLeave.start_date)
            : `${matchingLeave.start_date} → ${matchingLeave.end_date}`;
          prev.ranges.add(rangeStr);
          staffLeaveBreakdown.set(lType, prev);
          overallLeaveDays += 1;
        }
      }

      // Overtime object
      let otObj: MergedDailyRecord["overtime"] = null;
      if (otItem) {
        const payable = Number(otItem.payable_hours || 0);
        const totalH = Number(otItem.hours || 0);
        const otStatus = otItem.status as NonNullable<MergedDailyRecord["overtime"]>["status"];
        const isApp = otStatus === "approved";

        otObj = {
          id: String(otItem.id),
          payableHours: payable,
          totalHours: totalH,
          status: otStatus,
          isApproved: isApp,
          reason: String(otItem.reason || ""),
          startAt: String(otItem.start_at),
          endAt: String(otItem.end_at),
        };

        if (isApp) {
          staffApprovedOtHours += payable;
        } else if (otStatus === "pending") {
          staffPendingOtHours += payable;
          overallPendingOtCount += 1;
        }
      }

      const dailyRec: MergedDailyRecord = {
        date: dStr,
        profileId: profile.id,
        staffName: profile.name,
        staffNo: profile.staff_no,
        station: profile.station,
        team: profile.team,
        scheduledShift: rosterItem
          ? {
              code: rosterItem.shift_code,
              startTime: rosterItem.start_time,
              endTime: rosterItem.end_time,
            }
          : null,
        dutyRecord: dutyRecordObj,
        leave: leaveObj,
        overtime: otObj,
      };

      staffDailyEntries.push(dailyRec);
      allDailyRecords.push(dailyRec);
    }

    const staffHoursWorked = Math.round((staffTotalMinutes / 60) * 10) / 10;
    overallShiftsWorked += staffShiftsWorked;
    overallTotalMinutes += staffTotalMinutes;
    overallApprovedOtHours += staffApprovedOtHours;

    const leavesTakenArray = Array.from(staffLeaveBreakdown.entries()).map(([type, data]) => ({
      leaveType: type,
      leaveLabel: data.label,
      daysCount: data.count,
      dateRanges: Array.from(data.ranges),
    }));

    summaries.push({
      profileId: profile.id,
      staffName: profile.name,
      staffNo: profile.staff_no,
      station: profile.station,
      team: profile.team,
      role: profile.role,
      totalShiftsWorked: staffShiftsWorked,
      totalHoursWorked: staffHoursWorked,
      totalApprovedOtHours: staffApprovedOtHours,
      totalPendingOtHours: staffPendingOtHours,
      leavesTaken: leavesTakenArray,
      dailyEntries: staffDailyEntries,
    });
  }

  const overallHoursWorked = Math.round((overallTotalMinutes / 60) * 10) / 10;

  return {
    periodType,
    selectedDate,
    selectedMonth,
    selectedYear,
    dateFrom,
    dateTo,
    dateList,
    summaries,
    allDailyRecords,
    pagination: {
      page,
      pageSize,
      totalProfiles,
      totalPages,
    },
    totals: {
      totalStaff: totalProfiles,
      totalShiftsWorked: overallShiftsWorked,
      totalHoursWorked: overallHoursWorked,
      totalApprovedOtHours: overallApprovedOtHours,
      totalPendingOtCount: overallPendingOtCount,
      totalLeaveDaysTaken: overallLeaveDays,
    },
  };
}
