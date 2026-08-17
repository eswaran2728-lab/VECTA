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

  useEffect(() => {
    if (!showFlow || typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => setGeoError(err.message || "Couldn't get your location."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
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

  async function handleCheckIn() {
    if (!position) {
      setSubmitError("Waiting for your location…");
      return;
    }
    if (needsRemark && !remark.trim()) {
      setSubmitError("Please add a remark before checking in.");
      return;
    }
    setSubmitError(null);
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const outcome = await submitCheckIn({
      lat: position.lat,
      lng: position.lng,
      accuracy_m: position.accuracy,
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
    if (!position) {
      setSubmitError("Waiting for your location…");
      return;
    }
    if (needsRemark && !remark.trim()) {
      setSubmitError("Please add a remark before checking out.");
      return;
    }
    setSubmitError(null);
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const outcome = await submitCheckOut({
      lat: position.lat,
      lng: position.lng,
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
        disabled={submitting || !position}
        onClick={checkedIn ? handleCheckOut : handleCheckIn}
      >
        {submitting ? "Submitting…" : checkedIn ? "Check out" : "Check in"}
      </button>
    </div>
  );
}
