import { requireAttendanceProfile } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { ReviewControls } from "@/components/avsec/aircraft-search/ReviewControls";

interface SearchRow {
  id: string;
  kind: "search" | "missing";
  station: string;
  flight: string;
  registration: string;
  aircraft_type: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_minutes: number | null;
  below_minimum: boolean;
  below_minimum_reason: string | null;
  presence_status: "reported" | "unverified" | "historical_unverified";
  gps_unavailable_reason: string | null;
  review_state: "pending" | "confirmed" | "exception";
  review_note: string | null;
  reviewed_at: string | null;
  required_reasons: string[];
  std_gap_minutes: number | null;
  departure_gap_minutes: number | null;
  late_flag: boolean;
  late_reason: string | null;
  duplicate_ids: string[];
  created_at: string;
}

const REASON: Record<string, string> = { ground_4h: "on ground 4 h+", night_stop: "night stop", towed_from_hangar: "towed from hangar" };
const PRESENCE: Record<string, string> = { reported: "Location reported at start and finish", unverified: "Location unverified", historical_unverified: "Earlier record, not GPS verified" };

export default async function AircraftSearchReviewPage() {
  const profile = await requireAttendanceProfile();
  const supabase = (await createClient()) as unknown as {
    from: (t: string) => { select: (c: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown }> } } };
  };
  const { data } = await supabase.from("aircraft_search_records").select("*").order("created_at", { ascending: false }).limit(100);
  const rows = (data as SearchRow[] | null) ?? [];
  const open = rows.filter((r) => !r.reviewed_at && r.review_state !== "confirmed");
  const done = rows.filter((r) => r.reviewed_at || r.review_state === "confirmed");

  const Card = ({ r, review }: { r: SearchRow; review: boolean }) => (
    <div className="card space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          {r.registration} · {r.flight} · {r.station}
          {r.aircraft_type ? ` · ${r.aircraft_type}` : ""}
        </p>
        <span className="font-mono text-[11px] uppercase text-muted-foreground">{r.kind === "missing" ? "Required search missing" : r.review_state}</span>
      </div>
      {r.required_reasons.length > 0 && <p className="font-mono text-[11px] text-muted-foreground">Search required: {r.required_reasons.map((x) => REASON[x] ?? x).join(", ")}</p>}
      {r.kind === "search" && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {r.started_at ? `Started ${formatDateTimeMY(r.started_at)} (server time)` : "Start/finish time not recorded"}
          {r.duration_minutes !== null ? ` · ${Number(r.duration_minutes).toFixed(1)} min${r.below_minimum ? " (below minimum)" : ""}` : ""} · {PRESENCE[r.presence_status]}
        </p>
      )}
      {r.std_gap_minutes !== null && (
        <p className="font-mono text-[11px] text-muted-foreground">
          Gap to the staff-entered STD: {Number(r.std_gap_minutes).toFixed(0)} min · gap to SEC016: {r.departure_gap_minutes !== null ? `${Number(r.departure_gap_minutes).toFixed(0)} min` : "—"}
          {r.late_flag ? " · FLAGGED" : ""}
        </p>
      )}
      {r.gps_unavailable_reason && <p className="font-mono text-[11px] text-warning">Location reason: {r.gps_unavailable_reason}</p>}
      {r.below_minimum_reason && <p className="font-mono text-[11px] text-warning">Short-search reason: {r.below_minimum_reason}</p>}
      {r.late_reason && <p className="font-mono text-[11px] text-warning">Late/missing reason: {r.late_reason}</p>}
      {r.duplicate_ids.length > 0 && <p className="font-mono text-[11px] text-warning">{r.duplicate_ids.length} other SEC029 also match this departure.</p>}
      {r.review_note && <p className="font-mono text-[11px] text-foreground">Review: {r.review_note}</p>}
      {review && <ReviewControls recordId={r.id} canConfirm={r.kind === "search"} />}
    </div>
  );

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <div>
          <h1 className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">AIRCRAFT SEARCH REVIEW</h1>
          <p className="font-mono text-xs text-muted-foreground">{profile.station ?? "—"} · Only a different on-duty SO, SSO or DSE of the station can decide. Location is reported evidence, not proof of presence.</p>
        </div>
        <section className="space-y-3">
          <h2 className="section-title">Awaiting review ({open.length})</h2>
          {open.length === 0 ? <div className="card p-6 text-center font-mono text-xs text-muted-foreground">Nothing is waiting for review.</div> : open.map((r) => <Card key={r.id} r={r} review />)}
        </section>
        <section className="space-y-3">
          <h2 className="section-title">Decided ({done.length})</h2>
          {done.map((r) => <Card key={r.id} r={r} review={false} />)}
        </section>
      </div>
    </main>
  );
}
