"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { RemarkQuickPhrases } from "@/components/forms/fields";
import { submitDutyCheckIn, submitDutyCheckOut } from "@/lib/duty/checkin-actions";
import { useOfflineSubmit } from "@/lib/offline/useOfflineSubmit";
import { scheduledWindow, computeLateMinutes, computeEarlyMinutes } from "@/lib/duty/lateness";
import { pointInPolygon } from "@/lib/duty/geofence";
import { todayISODateMY, formatTimeMY } from "@/lib/datetime";
import type { DutyZone, TodayRoster, DutyRecordRow } from "@/lib/duty/types";

const DutyMap = dynamic(() => import("./DutyMap"), {
  ssr: false,
  loading: () => (
    <div
      className="h-[220px] flex items-center justify-center t-mono text-[10px]"
      style={{ color: "var(--faint)", background: "var(--panel2)" }}
    >
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

export function CheckInScreen({
  roster,
  zone,
  record,
}: {
  roster: TodayRoster | null;
  zone: DutyZone | null;
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
          if (!cancelled) setGeoError(err instanceof Error ? err.message : "Couldn't get your location.");
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

  const insideFence = useMemo(() => {
    if (!position || !zone) return null;
    return pointInPolygon(position.lng, position.lat, zone.polygon);
  }, [position, zone]);

  const scheduled = useMemo(() => {
    if (!roster?.start_time || !roster?.end_time) return null;
    return scheduledWindow(todayISODateMY(), roster.start_time, roster.end_time);
  }, [roster]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [tick]);

  const predictedLate = scheduled && !checkedIn && !isOff ? computeLateMinutes(scheduled.start, now) : 0;
  const predictedEarly = scheduled && checkedIn && !record?.check_out_at ? computeEarlyMinutes(scheduled.end, now) : 0;
  const needsRemark = !checkedIn ? predictedLate > 0 : predictedEarly > 0;

  // Both check-in and check-out require being at the assigned zone's pin-point location.
  const zoneBlocked = !!zone && insideFence === false;

  // Re-fetches location right now rather than trusting whatever `position` currently
  // holds — that state can be up to ~15s old from the live-badge poll, and reusing a
  // check-in-time reading for check-out is exactly how someone could check in inside the
  // zone, walk away, and still have check-out wrongly succeed.
  async function resolveCurrentPosition(): Promise<GeoPosition | null> {
    setLocating(true);
    try {
      const fresh = await fetchFreshPosition();
      setPosition(fresh);
      setGeoError(null);
      return fresh;
    } catch (err) {
      setGeoError(err instanceof Error ? err.message : "Couldn't get your location.");
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
    if (zone && pointInPolygon(fresh.lng, fresh.lat, zone.polygon) === false) {
      setSubmitError(`You must be at ${zone.name} to check in — move to the pin-point location and try again.`);
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
      offline,
      client_timestamp: new Date().toISOString(),
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
    if (zone && pointInPolygon(fresh.lng, fresh.lat, zone.polygon) === false) {
      setSubmitError(`You must be at ${zone.name} to check out — move to the pin-point location and try again.`);
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
      offline,
      client_timestamp: new Date().toISOString(),
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
    return <div className="disclaimer-band">No roster set for today — contact your supervisor.</div>;
  }

  if (isOff && !forceShow && !record) {
    return (
      <div className="card p-5 space-y-3">
        <p className="t-mono text-[10px] font-semibold" style={{ color: "var(--gold)" }}>
          SCHEDULED
        </p>
        <p className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
          You&apos;re off today
        </p>
        <button type="button" className="btn-secondary w-full" onClick={() => setForceShow(true)}>
          Check in anyway (covering another team)
        </button>
      </div>
    );
  }

  if (queuedKind) {
    return (
      <div className="card p-5 space-y-2" style={{ borderLeft: "3px solid var(--blue)" }}>
        <p className="t-mono text-[10px] font-semibold" style={{ color: "var(--blue)" }}>
          QUEUED OFFLINE
        </p>
        <p className="text-[13px]" style={{ color: "var(--soft)" }}>
          You&apos;re offline. This {queuedKind === "in" ? "check-in" : "check-out"} is saved on your device and
          will submit automatically once you&apos;re back online — no re-entry needed.
        </p>
      </div>
    );
  }

  if (record?.check_out_at) {
    return (
      <div className="card p-5 space-y-2">
        <p className="t-mono text-[10px] font-semibold" style={{ color: "var(--gold)" }}>
          SHIFT COMPLETE
        </p>
        <p className="text-[13px]" style={{ color: "var(--soft)" }}>
          Checked in {formatTimeMY(record.check_in_at)} · Checked out {formatTimeMY(record.check_out_at)}
        </p>
        {record.late_minutes > 0 && (
          <p className="t-mono text-[10px]" style={{ color: "var(--red)" }}>
            LATE {record.late_minutes} MIN — {record.late_remark}
          </p>
        )}
        {record.early_out_minutes > 0 && (
          <p className="t-mono text-[10px]" style={{ color: "var(--red)" }}>
            EARLY OUT {record.early_out_minutes} MIN — {record.early_out_remark}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card overflow-hidden">
        <DutyMap position={position} zone={zone} />
      </div>

      {checkedIn && (
        <div className="card p-4">
          <p className="t-mono text-[10px] font-semibold" style={{ color: "var(--gold)" }}>
            ON DUTY SINCE {formatTimeMY(record!.check_in_at)}
          </p>
        </div>
      )}

      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
            {roster.shift_code}
            {roster.start_time && roster.end_time
              ? ` · ${roster.start_time.slice(0, 5)}–${roster.end_time.slice(0, 5)}`
              : ""}
          </span>
          {zone && (
            <span
              className="t-mono text-[9px] font-bold px-2 py-1 shrink-0"
              style={{
                color: insideFence === false ? "var(--red)" : "var(--green)",
                border: `1px solid ${insideFence === false ? "var(--red)" : "var(--green)"}`,
              }}
            >
              {insideFence === null ? "LOCATING…" : insideFence ? `IN RANGE: ${zone.name}` : "OUT OF RANGE"}
            </span>
          )}
        </div>
        {geoError && <p className="field-error">{geoError}</p>}
        {position && (
          <p className="t-mono text-[9px]" style={{ color: "var(--faint)" }}>
            Accuracy ±{Math.round(position.accuracy)}m
            {position.accuracy > 100 ? " — low accuracy, still allowed" : ""}
          </p>
        )}
        {zoneBlocked && (
          <p className="field-error">
            Move to {zone!.name} to {checkedIn ? "check out" : "check in"} — you must be at the pin-point
            location.
          </p>
        )}
      </div>

      {needsRemark && (
        <div className="card p-4 space-y-2">
          <p className="field-label">
            {checkedIn ? "Leaving early — explanation required" : "Checking in late — explanation required"}
          </p>
          <textarea
            className="input-base"
            rows={2}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Reason…"
          />
          <RemarkQuickPhrases value={remark} onChange={setRemark} phrases={LATE_PHRASES} />
        </div>
      )}

      {submitError && <p className="field-error">{submitError}</p>}

      <button
        type="button"
        className="btn-primary w-full"
        disabled={submitting || locating || !position || zoneBlocked}
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
