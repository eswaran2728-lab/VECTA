import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { entityLeadershipFromRoleCodes } from "@/lib/dashboard/entity-leadership-roles";
import { AddBayBoardForm } from "@/components/avsec/forms/AddBayBoardForm";
import { BayBoardList } from "@/components/avsec/bay-board/BayBoardList";
import { EntityBayBoard } from "@/components/avsec/bay-board/EntityBayBoard";

export default async function BayBoardPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await requireProfile();
  const params = await searchParamsPromise;
  const leadership = entityLeadershipFromRoleCodes((profile.canonical as CanonicalAccess).roleCodes);

  if (leadership) {
    // MAA/AAX Boss and Admin: read-only board with a Hub + Station selector (no station of their own, no entity inference).
    return (
      <main className="min-h-screen pb-32">
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
          <h1 className="font-display text-xl font-bold">Bay Board</h1>
          <EntityBayBoard hubCode={params.hub?.trim() || null} stationCode={params.station?.trim() || null} />
        </div>
      </main>
    );
  }

  // Station-scoped staff keep the existing board for their own station.
  const entries = await getOpenBayBoard(profile.station ?? undefined);

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          All originating flights, including aircraft brought into service for the first flight of the day, aircraft parked overnight, night stop aircraft, long layover aircraft, or unattended aircraft, shall undergo a security search before Scheduled Time of Departure (STD).
          Arrival SEC016 submissions automatically place aircraft on this board, and Departure SEC016 submissions clear them.
        </p>

        {profile.station ? <AddBayBoardForm station={profile.station} /> : null}

        <BayBoardList initialEntries={entries} station={profile.station} />
      </div>
    </main>
  );
}
