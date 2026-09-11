import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { Clock, CheckCircle2, ArrowRight } from "lucide-react";

export default async function NewOvertimeRequestPage() {
  await requireProfile();

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        <div>
          <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
            OVERTIME INFORMATION
          </span>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Automated Overtime Detection & Calculation System
          </p>
        </div>

        <div className="vecta-panel space-y-4 p-6 border-primary/30 bg-primary/5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Clock className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-bold text-foreground">Overtime is Auto-Calculated</h2>
              <p className="text-xs text-muted-foreground">No manual request submission is required.</p>
            </div>
          </div>

          <div className="space-y-3 pt-2 text-xs text-foreground/90 leading-relaxed">
            <p>
              VECTA automatically calculates your overtime directly from your <strong>duty check-in and check-out timestamps</strong> compared against your <strong>scheduled roster shift end time</strong>.
            </p>
            <div className="rounded-lg bg-background/80 p-3.5 border border-border space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                <span>
                  <strong>Check out as normal</strong> at the end of your shift on the Duty Check-In/Out page.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                <span>
                  <strong>Completed whole hours</strong> worked beyond your rostered shift end time are automatically calculated and recorded.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                <span>
                  Your <strong>DSE</strong> will review and approve the auto-generated overtime record directly in their queue.
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Link href="/avsec/duty" className="vecta-btn-primary flex-1 text-center flex items-center justify-center gap-2">
              <span>Go to Duty Check-Out</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/avsec/duty/overtime" className="btn-secondary flex-1 text-center">
              View Overtime History
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
