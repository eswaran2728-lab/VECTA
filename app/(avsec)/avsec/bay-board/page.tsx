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

  // An org-wide viewer (Admin/Management/Enforcement) has no single station
  // of their own — previously that meant `entries` was silently left empty
  // ("No aircraft currently logged on ground at ."), when what they actually
  // want is the board across every station.
  const entries = await getOpenBayBoard(profile.station ?? undefined);

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          All originating flights, including aircraft brought into service for the first flight of the day, aircraft parked overnight, night stop aircraft, long layover aircraft, or unattended aircraft, shall undergo a security search before Scheduled Time of Departure (STD).
          Arrival SEC016 submissions automatically place aircraft on this board, and Departure SEC016 submissions clear them.
        </p>

        {/* Manual add always applies to one specific station, which an
            org-wide viewer doesn't have — station-scoped viewers only. */}
        {profile.station ? <AddBayBoardForm station={profile.station} /> : null}

        <BayBoardList initialEntries={entries} station={profile.station} />
      </div>
    </main>
  );
}
