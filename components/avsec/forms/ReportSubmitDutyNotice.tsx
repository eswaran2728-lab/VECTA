import Link from "next/link";
import { hasOpenDutyCheckIn } from "@/lib/avsec/duty/checkin-queries";

export async function ReportSubmitDutyNotice({ profileId }: { profileId: string }) {
  if (await hasOpenDutyCheckIn(profileId)) return null;

  return (
    <div role="status" className="vecta-panel mb-4 border-l-[3px] border-l-warning bg-warning/5 px-4 py-3 text-sm text-foreground">
      <strong>Check in to submit.</strong> You can prepare this form and save a draft while off duty. To submit a security report, first {" "}
      <Link href="/avsec/duty" className="font-semibold underline underline-offset-2">open Duty Check-In</Link>.
    </div>
  );
}
