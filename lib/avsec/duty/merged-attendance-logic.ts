export type PeriodType = "day" | "month" | "year";

export interface MergedAttendanceFilter {
  periodType?: PeriodType;
  date?: string; // YYYY-MM-DD
  month?: string; // YYYY-MM
  year?: string; // YYYY
  station?: string;
  team?: string;
  search?: string;
}

export function computePeriodDateRange(filters: MergedAttendanceFilter): {
  periodType: PeriodType;
  selectedDate: string;
  selectedMonth: string;
  selectedYear: string;
  dateFrom: string;
  dateTo: string;
  dateList: string[];
} {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);
  const periodType: PeriodType = filters.periodType || (filters.year ? "year" : filters.month ? "month" : "day");

  const selectedDate = filters.date || today;
  const currentYearMonth = today.slice(0, 7);
  const selectedMonth = filters.month || (filters.date ? filters.date.slice(0, 7) : currentYearMonth);
  const currentYear = today.slice(0, 4);
  const selectedYear = filters.year || (filters.month ? filters.month.slice(0, 4) : filters.date ? filters.date.slice(0, 4) : currentYear);

  let dateFrom = selectedDate;
  let dateTo = selectedDate;

  if (periodType === "day") {
    dateFrom = selectedDate;
    dateTo = selectedDate;
  } else if (periodType === "month") {
    const [yStr, mStr] = selectedMonth.split("-");
    const y = parseInt(yStr || currentYear, 10);
    const m = parseInt(mStr || "1", 10);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    dateFrom = `${selectedMonth}-01`;
    dateTo = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;
  } else if (periodType === "year") {
    dateFrom = `${selectedYear}-01-01`;
    dateTo = `${selectedYear}-12-31`;
  }

  // Generate date list between dateFrom and dateTo
  const dateList: string[] = [];
  const curr = new Date(dateFrom + "T00:00:00Z");
  const end = new Date(dateTo + "T00:00:00Z");
  while (curr <= end) {
    dateList.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  return {
    periodType,
    selectedDate,
    selectedMonth,
    selectedYear,
    dateFrom,
    dateTo,
    dateList,
  };
}
