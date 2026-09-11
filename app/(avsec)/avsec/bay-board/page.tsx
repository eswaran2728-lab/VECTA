import { redirect } from "next/navigation";
import { requireProfile, landingPathForRole } from "@/lib/avsec/auth";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { AddBayBoardForm } from "@/components/avsec/forms/AddBayBoardForm";
import { BayBoardList } from "@/components/avsec/bay-board/BayBoardList";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";

export default async function BayBoardPage() {
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role) || profile.role === "ADMIN";

  // Bay Board is strictly an Operation AVSEC feature — do not expose to IFC
  if (!orgWide && profile.ops_group === "ifc_avsec") {
    redirect(landingPathForRole(profile.role));
  }

  const entries = profile.station ? await getOpenBayBoard(profile.station) : [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Aircraft on ground exceeding 4 hours require an Aircraft Search prior to departure.
          Arrival SEC016 submissions automatically place aircraft on this board, and Departure SEC016 submissions clear them.
        </p>

        <AddBayBoardForm station={profile.station!} />

        <BayBoardList initialEntries={entries} station={profile.station!} />
      </div>
    </main>
  );
}
