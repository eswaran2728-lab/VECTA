"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { submitDutyCheckIn, submitDutyCheckOut } from "@/lib/avsec/duty/checkin-actions";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { scheduledWindow, computeLateMinutes, computeEarlyMinutes } from "@/lib/avsec/duty/lateness";
import { pointInPolygon } from "@/lib/avsec/duty/geofence";
import { todayISODateMY, formatTimeMY } from "@/lib/avsec/datetime";
import type { DutyZone, TodayRoster, DutyRecordRow } from "@/lib/avsec/duty/types";

const DutyMap = dynamic(() => import("./DutyMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[220px] items-center justify-center bg-card font-mono text-[10px] text-muted-foreground">
      Loading map…
    </div>
  ),
});

interface GeoPosition {
  lat: number;
  lng: number;
  accuracy: number;
}

const LATE_PHRASES = ["Traffic / transport delay", "Medical", "Approved by supervisor", "Ops requirement"];

// Every team checks in/out at any of the station's marked zones — not one zone assigned
// per shift. `matchZone` returns the first zone the position falls inside, or null if it's
// outside all of them (or there are none at all, in which case there's nothing to enforce).
function matchZone(position: { lat: number; lng: number } | null, zones: DutyZone[]): DutyZone | null {
  if (!position) return null;
  return zones.find((z) => pointInPolygon(position.lng, position.lat, z.polygon)) ?? null;
}

/** Tap-to-append quick phrases for the late/early-out remark box — a local, vecta-styled
 * stand-in for the shared RemarkQuickPhrases component (components/avsec/forms/fields.tsx),
 * which is still on the old theme and is shared by ~7 not-yet-restyled report forms. Same
 * append behavior, kept local so restyling Duty doesn't touch that shared file. */
function QuickPhrases({ value, onChange, phrases }: { value: string; onChange: (next: string) => void; phrases: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {phrases.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onChange((value ? value.trim() + ". " : "") + text)}
          className="rounded-full border border-dashed border-border px-2.5 py-1.5 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          + {text}
        </button>
      ))}
    </div>
  );
}

export function CheckInScreen({
  roster,
  zones,
  record,
}: {
  roster: TodayRoster | null;
  zones: DutyZone[];
  record: DutyRecordRow | null;
}) {
  const router = useRouter();
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [forceShow, setForceShow] = useState(false);
  const [remark, setRemark] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedKind, setQueuedKind] = useState<"in" | "out" | null>(null);
  const [tick, setTick] = useState(0);
  const [locating, setLocating] = useState(false);
  // GPS-denial fallback: once geolocation has failed at least once, offer a manual
  // zone picker instead of blocking the officer entirely. `manualZoneId` set means the
  // officer is proceeding on their manual choice rather than a live GPS fix.
  const [geoFailed, setGeoFailed] = useState(false);
  const [manualZoneId, setManualZoneId] = useState<string>("");

  const { submit: submitCheckIn, pending: submittingIn } = useOfflineSubmit("duty_checkin", submitDutyCheckIn);
  const { submit: submitCheckOut, pending: submittingOut } = useOfflineSubmit("duty_checkout", submitDutyCheckOut);
  const submitting = submittingIn || submittingOut;

  const isOff = roster?.shift_code === "OFF";
  const showFlow = !!roster && (!isOff || forceShow || !!record);
  const checkedIn = !!record?.check_in_at;

  useEffect(() => {
    if (!showFlow) return;
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [showFlow]);

  // Fetches the device's *current* position — never trust a position captured earlier in
  // the session. Both display polling below and the submit handlers call this fresh each
  // time, so a check-out can never reuse a stale, still-inside-the-zone reading from an
  // earlier check-in.
  function fetchFreshPosition(): Promise<GeoPosition> {
    return new Promise((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("Location services are unavailable on this device."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(new Error(err.message || "Couldn't get your location.")),
        { enableHighAccuracy: true, timeout: 15000 },
      );
    });
  }

  useEffect(() => {
    if (!showFlow) return;
    let cancelled = false;
    const poll = () => {
      fetchFreshPosition()
        .then((pos) => {
          if (!cancelled) {
            setPosition(pos);
            setGeoError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setGeoError(err instanceof Error ? err.message : "Couldn't get your location.");
            setGeoFailed(true);
          }
        });
    };
    poll();
    // Keep the on-screen "IN RANGE / OUT OF RANGE" badge live while the officer is
    // standing on this screen — the authoritative check still re-fetches at submit time.
    const interval = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showFlow]);

  const manualZone = useMemo(() => zones.find((z) => z.id === manualZoneId) ?? null, [zones, manualZoneId]);
  const gpsMatchedZone = useMemo(() => matchZone(position, zones), [position, zones]);
  const matchedZone = manualZone ?? gpsMatchedZone;
  const insideFence = manualZone ? true : !position ? null : zones.length === 0 ? null : !!gpsMatchedZone;

  const scheduled = useMemo(() => {
    if (!roster?.start_time || !roster?.end_time) return null;
    return scheduledWindow(todayISODateMY(), roster.start_time, roster.end_time);
  }, [roster]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [tick]);

  const predictedLate = scheduled && !checkedIn && !isOff ? computeLateMinutes(scheduled.start, now) : 0;
  // Reuses computeEarlyMinutes against the scheduled *start* — same formula
  // (scheduledPoint - actual), just applied the other side of the shift window.
  const predictedEarlyIn = scheduled && !checkedIn && !isOff ? computeEarlyMinutes(scheduled.start, now) : 0;
  const predictedEarly = scheduled && checkedIn && !record?.check_out_at ? computeEarlyMinutes(scheduled.end, now) : 0;
  // Reuses computeLateMinutes against the scheduled *end* — same formula
  // (actual - scheduledPoint), just applied the other side of the shift window.
  const predictedLateOut = scheduled && checkedIn && !record?.check_out_at ? computeLateMinutes(scheduled.end, now) : 0;
  const needsRemark = !checkedIn ? predictedLate > 0 || predictedEarlyIn > 0 : predictedEarly > 0 || predictedLateOut > 0;

  // Both check-in and check-out require being inside one of the station's marked zones.
  // No zones defined at all means nothing to enforce.
  const zoneBlocked = zones.length > 0 && insideFence === false;

  // Re-fetches location right now rather than trusting whatever `position` currently
  // holds — that state can be up to ~15s old from the live-badge poll, and reusing a
  // check-in-time reading for check-out is exactly how someone could check in inside the
  // zone, walk away, and still have check-out wrongly succeed.
  async function resolveCurrentPosition(): Promise<GeoPosition | null> {
    // A manual zone selection stands in for GPS entirely — use the zone's own center as
    // the recorded coordinate rather than requiring a fresh (and likely still-failing)
    // GPS fix just to get a lat/lng to store.
    if (manualZone) {
      const manualPos = { lat: manualZone.center_lat, lng: manualZone.center_lng, accuracy: 0 };
      setPosition(manualPos);
      setGeoError(null);
      return manualPos;
    }
    setLocating(true);
    try {
      const fresh = await fetchFreshPosition();
      setPosition(fresh);
      setGeoError(null);
      return fresh;
    } catch (err) {
      setGeoError(err instanceof Error ? err.message : "Couldn't get your location.");
      setGeoFailed(true);
      return null;
    } finally {
      setLocating(false);
    }
  }

  async function handleCheckIn() {
    setSubmitError(null);
    const fresh = await resolveCurrentPosition();
    if (!fresh) {
      setSubmitError("Couldn't confirm your current location — try again.");
      return;
    }
    if (!manualZone && zones.length > 0 && !matchZone(fresh, zones)) {
      setSubmitError("You must be within a marked duty zone to check in — move to one of the zones and try again.");
      return;
    }
    if (needsRemark && !remark.trim()) {
      setSubmitError("Please add a remark before checking in.");
      return;
    }
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const outcome = await submitCheckIn({
      lat: fresh.lat,
      lng: fresh.lng,
      accuracy_m: fresh.accuracy,
      late_remark: remark,
      early_in_remark: remark,
      offline,
      client_timestamp: new Date().toISOString(),
      manual_zone_id: manualZone?.id ?? "",
    });
    if (outcome.kind === "error") {
      setSubmitError(outcome.message);
      return;
    }
    setRemark("");
    if (outcome.kind === "queued") {
      setQueuedKind("in");
      return;
    }
    router.refresh();
  }

  async function handleCheckOut() {
    setSubmitError(null);
    const fresh = await resolveCurrentPosition();
    if (!fresh) {
      setSubmitError("Couldn't confirm your current location — try again.");
      return;
    }
    if (!manualZone && zones.length > 0 && !matchZone(fresh, zones)) {
      setSubmitError("You must be within a marked duty zone to check out — move to one of the zones and try again.");
      return;
    }
    if (needsRemark && !remark.trim()) {
      setSubmitError("Please add a remark before checking out.");
      return;
    }
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const outcome = await submitCheckOut({
      lat: fresh.lat,
      lng: fresh.lng,
      early_out_remark: remark,
      late_out_remark: remark,
      offline,
      client_timestamp: new Date().toISOString(),
      manual_zone_id: manualZone?.id ?? "",
    });
    if (outcome.kind === "error") {
      setSubmitError(outcome.message);
      return;
    }
    setRemark("");
    if (outcome.kind === "queued") {
      setQueuedKind("out");
      return;
    }
    router.refresh();
  }

  if (!roster) {
    return (
      <div className="vecta-panel border-brand/40 bg-brand/10 px-5 py-4 text-sm font-medium text-brand">
        No roster set for today — contact your supervisor.
      </div>
    );
  }

  if (isOff && !forceShow && !record) {
    return (
      <div className="vecta-panel space-y-3">
        <p className="vecta-eyebrow text-primary">Scheduled</p>
        <p className="text-[15px] font-semibold text-foreground">You&apos;re off today</p>
        <button type="button" className="vecta-btn-primary w-full !bg-secondary !text-foreground" onClick={() => setForceShow(true)}>
          Check in anyway (covering another team)
        </button>
      </div>
    );
  }

  if (queuedKind) {
    return (
      <div className="vecta-panel space-y-2 border-l-[3px] border-l-primary">
        <p className="vecta-eyebrow text-primary">Queued offline</p>
        <p className="text-[13px] text-muted-foreground">
          You&apos;re offline. This {queuedKind === "in" ? "check-in" : "check-out"} is saved on your device and
          will submit automatically once you&apos;re back online — no re-entry needed.
        </p>
      </div>
    );
  }

  if (record?.check_out_at) {
    return (
      <div className="vecta-panel space-y-2">
        <p className="vecta-eyebrow text-success">Shift complete</p>
        <p className="text-[13px] text-muted-foreground">
          Checked in {formatTimeMY(record.check_in_at)} · Checked out {formatTimeMY(record.check_out_at)}
        </p>
        {record.late_minutes > 0 && (
          <p className="font-mono text-[10px] text-brand">
            LATE {record.late_minutes} MIN — {record.late_remark}
          </p>
        )}
        {record.early_in_minutes > 0 && (
          <p className="font-mono text-[10px] text-brand">
            EARLY CHECK-IN {record.early_in_minutes} MIN — {record.early_in_remark}
          </p>
        )}
        {record.early_out_minutes > 0 && (
          <p className="font-mono text-[10px] text-brand">
            EARLY OUT {record.early_out_minutes} MIN — {record.early_out_remark}
          </p>
        )}
        {record.late_out_minutes > 0 && (
          <p className="font-mono text-[10px] text-brand">
            LATE CHECKOUT {record.late_out_minutes} MIN — {record.late_out_remark}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="vecta-panel overflow-hidden !p-0">
        <DutyMap position={position} zones={zones} />
      </div>

      {checkedIn && (
        <div className="vecta-panel !py-4">
          <p className="vecta-eyebrow text-success">On duty since {formatTimeMY(record!.check_in_at)}</p>
        </div>
      )}

      <div className="vecta-panel space-y-2 !py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {roster.shift_code}
            {roster.start_time && roster.end_time
              ? ` · ${roster.start_time.slice(0, 5)}–${roster.end_time.slice(0, 5)}`
              : ""}
          </span>
          {zones.length > 0 && (
            <span
              className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.06em] ${
                insideFence === false ? "border-brand text-brand" : "border-success text-success"
              }`}
            >
              {insideFence === null ? "Locating…" : matchedZone ? `In range: ${matchedZone.name}` : "Out of range"}
            </span>
          )}
        </div>
        {geoError && <p className="font-mono text-[10px] text-brand">{geoError}</p>}
        {geoFailed && !manualZone && zones.length > 0 && (
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] text-muted-foreground">
              Location unavailable — select your zone manually instead:
            </p>
            <select
              className="vecta-input"
              value={manualZoneId}
              onChange={(e) => setManualZoneId(e.target.value)}
            >
              <option value="">Select a zone…</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {manualZone && (
          <p className="font-mono text-[10px] text-muted-foreground">
            Zone selected manually: {manualZone.name}.{" "}
            <button type="button" className="underline" onClick={() => setManualZoneId("")}>
              Clear
            </button>
          </p>
        )}
        {position && (
          <p className="font-mono text-[9px] text-muted-foreground">
            Accuracy ±{Math.round(position.accuracy)}m
            {position.accuracy > 100 ? " — low accuracy, still allowed" : ""}
          </p>
        )}
        {zoneBlocked && (
          <p className="font-mono text-[10px] text-brand">
            Move to a marked duty zone to {checkedIn ? "check out" : "check in"}.
          </p>
        )}
      </div>

      {needsRemark && (
        <div className="vecta-panel space-y-2 !py-4">
          <p className="vecta-label">
            {checkedIn
              ? predictedEarly > 0
                ? "Leaving early — explanation required"
                : "Checking out late — explanation required"
              : predictedLate > 0
                ? "Checking in late — explanation required"
                : "Checking in early — explanation required"}
          </p>
          <textarea
            className="vecta-input h-auto py-2.5"
            rows={2}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Reason…"
          />
          <QuickPhrases value={remark} onChange={setRemark} phrases={LATE_PHRASES} />
        </div>
      )}

      {submitError && <p className="font-mono text-[11px] text-brand">{submitError}</p>}

      <button
        type="button"
        className="vecta-btn-primary w-full"
        disabled={submitting || locating || (!position && !manualZone) || zoneBlocked}
        onClick={checkedIn ? handleCheckOut : handleCheckIn}
      >
        {submitting
          ? "Submitting…"
          : locating
            ? "Confirming your location…"
            : zoneBlocked
              ? `Move to zone to ${checkedIn ? "check out" : "check in"}`
              : checkedIn
                ? "Check out"
                : "Check in"}
      </button>
    </div>
  );
}
