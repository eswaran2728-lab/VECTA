"use client";

import { useState } from "react";
import { finishAircraftSearch, startAircraftSearch, type Fix } from "@/lib/avsec/aircraft-search/actions";

function readLocation(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 },
    );
  });
}

/**
 * Records the physical search with SERVER time and the device's REPORTED location at the start and at the finish. The location is evidence of where the
 * phone said it was; it does not prove the officer was at the aircraft. Without a location the officer gives a reason and the search is marked unverified
 * and sent for review. The staff-entered Time Commence / Time Completed on the form are separate and unchanged.
 */
export function SearchTimerPanel({
  station,
  flight,
  registration,
  aircraftType,
  recordId,
  gpsReason,
  belowMinReason,
  onChange,
}: {
  station: string;
  flight: string;
  registration: string;
  aircraftType: string;
  recordId: string;
  gpsReason: string;
  belowMinReason: string;
  onChange: (patch: { recordId?: string; gpsReason?: string; belowMinReason?: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [below, setBelow] = useState<{ minutes: number; minimum: number | null } | null>(null);
  const [finished, setFinished] = useState(false);
  const ready = Boolean(station && flight.trim() && registration.trim());

  const start = async () => {
    setBusy(true);
    setError(null);
    const fix = await readLocation();
    if (!fix && gpsReason.trim().length < 5) {
      setNeedReason(true);
      setBusy(false);
      setError("Location is unavailable. Give a reason below, then start again.");
      return;
    }
    const r = await startAircraftSearch({ flight, registration, station, aircraftType, fix, unavailableReason: fix ? undefined : gpsReason });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onChange({ recordId: r.recordId });
    setFinished(false);
    setStatus(fix ? `Search started. Reported location recorded (±${Math.round(fix.accuracyM)} m).` : "Search started without location. It will be marked unverified and reviewed.");
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    const fix = await readLocation();
    if (!fix && gpsReason.trim().length < 5) {
      setNeedReason(true);
      setBusy(false);
      setError("Location is unavailable. Give a reason below, then finish again.");
      return;
    }
    const r = await finishAircraftSearch({ recordId, fix, unavailableReason: fix ? undefined : gpsReason });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setFinished(true);
    setBelow(r.belowMinimum ? { minutes: r.minutes, minimum: r.minimum } : null);
    setStatus(`Search finished: ${r.minutes.toFixed(1)} minutes by server time. ${r.presence === "reported" ? "Reported location recorded at start and finish." : "Location unverified."}`);
  };

  return (
    <div className="card p-4 space-y-3 border border-border/60" data-testid="search-timer">
      <h3 className="section-title">Physical search record</h3>
      <p className="font-mono text-[11px] text-muted-foreground">
        Press Start when you begin searching the aircraft and Finish when done. The time is taken by the server and your phone&apos;s reported location is recorded. This is reported
        location evidence, not proof of presence. A supervising officer reviews every search.
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-xs px-3 py-2" disabled={!ready || busy || Boolean(recordId && !finished)} onClick={start}>
          {busy && !recordId ? "Starting…" : "Start search"}
        </button>
        <button type="button" className="btn-secondary text-xs px-3 py-2" disabled={!recordId || finished || busy} onClick={finish}>
          {busy && recordId ? "Finishing…" : "Finish search"}
        </button>
      </div>
      {!ready && <p className="font-mono text-[11px] text-muted-foreground">Enter the station, flight and registration first.</p>}
      {needReason && (
        <div>
          <label className="field-label" htmlFor="gps-reason">Reason location is unavailable (required)</label>
          <textarea id="gps-reason" rows={2} className="input-base text-xs" value={gpsReason} onChange={(e) => onChange({ gpsReason: e.target.value })} placeholder="e.g. Phone location is switched off at the bay" />
        </div>
      )}
      {below && (
        <div>
          <label className="field-label" htmlFor="below-min">Search was {below.minutes.toFixed(1)} minutes; the minimum is {below.minimum} minutes. Reason (required)</label>
          <textarea id="below-min" rows={2} className="input-base text-xs" value={belowMinReason} onChange={(e) => onChange({ belowMinReason: e.target.value })} />
        </div>
      )}
      {status && <p className="font-mono text-[11px] text-success">{status}</p>}
      {error && <p className="font-mono text-xs text-destructive">{error}</p>}
    </div>
  );
}
