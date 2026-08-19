// Whole completed hours only, never rounded up — matches overtime_requests.payable_hours
// (a generated column using the same formula). Keep the two in sync.
export function calcOtHours(scheduledEnd: Date, checkOut: Date): number {
  const minutesPast = Math.floor((checkOut.getTime() - scheduledEnd.getTime()) / 60000);
  if (minutesPast <= 0) return 0;
  return Math.floor(minutesPast / 60);
}
