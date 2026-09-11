"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { submitDutyCheckIn, submitDutyCheckOut } from "@/lib/avsec/duty/checkin-actions";
import { submitLeaveApplication } from "@/lib/avsec/duty/absence-actions";
import {
  formatAbsenceGap,
  calculateAbsenceGap,
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ICONS,
  type LeaveType,
  isSameDayLeave,
} from "@/lib/avsec/duty/absence-logic";
import type { AbsenceNoticeRow } from "@/lib/avsec/duty/absence-queries";
import { useOfflineSubmit } from "@/lib/avsec/offline/useOfflineSubmit";
import { scheduledWindow, computeLateMinutes, computeEarlyMinutes } from "@/lib/avsec/duty/lateness";
import { pointInPolygon } from "@/lib/avsec/duty/geofence";
import { todayISODateMY, formatTimeMY, formatDateTimeMY } from "@/lib/avsec/datetime";
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
const LEAVE_PHRASES = [
  "Informed DSE via phone",
  "Medical unwell / Sick Leave to follow",
  "Family emergency",
  "Scheduled annual leave",
  "Approved operational relief",
];

// Every team checks in/out at any of the station's marked zones — not one zone assigned
// per shift. `matchZone` returns the first zone the position falls inside, or null if it's
// outside all of them (or there are none at all, in which case there's nothing to enforce).
function matchZone(position: { lat: number; lng: number } | null, zones: DutyZone[]): DutyZone | null {
  if (!position) return null;
  return zones.find((z) => pointInPolygon(position.lng, position.lat, z.polygon)) ?? null;
}

/** Tap-to-append quick phrases for remarks */
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
  initialAbsence = null,
}: {
  roster: TodayRoster | null;
  zones: DutyZone[];
  record: DutyRecordRow | null;
  initialAbsence?: AbsenceNoticeRow | null;
}) {
  const router = useRouter();
  const today = todayISODateMY();

  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [forceShow, setForceShow] = useState(false);
  const [remark, setRemark] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queuedKind, setQueuedKind] = useState<"in" | "out" | null>(null);
  const [tick, setTick] = useState(0);
  const [locating, setLocating] = useState(false);

  // Consolidated Leave State
  const [showLeaveForm, setShowLeaveForm] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>("absent");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [leaveRemarks, setLeaveRemarks] = useState("");
  const [submittingLeave, setSubmittingLeave] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [leaveNotice, setLeaveNotice] = useState<AbsenceNoticeRow | null>(initialAbsence);

  const { submit: submitCheckIn, pending: submittingIn } = useOfflineSubmit("duty_checkin", submitDutyCheckIn);
  const { submit: submitCheckOut, pending: submittingOut } = useOfflineSubmit("duty_checkout", submitDutyCheckOut);
  const submitting = submittingIn || submittingOut;

  const isOff = roster?.shift_code === "OFF";
  const checkedIn = !!record?.check_in_at;

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const now = useMemo(() => new Date(), [tick]);

  const scheduled = useMemo(() => {
    if (!roster || isOff || !roster.start_time || !roster.end_time) return null;
    return scheduledWindow(today, roster.start_time, roster.end_time);
  }, [roster, isOff, today]);

  const insideZone = useMemo(() => matchZone(position, zones), [position, zones]);
  const zoneBlocked = zones.length > 0 && !insideZone;

  // Lateness / early-out calculations
  const predictedLate = useMemo(() => {
    if (!scheduled || checkedIn) return 0;
    return computeLateMinutes(scheduled.start, now);
  }, [scheduled, checkedIn, now]);

  const predictedEarlyOut = useMemo(() => {
    if (!scheduled || !checkedIn) return 0;
    return computeEarlyMinutes(scheduled.end, now);
  }, [scheduled, checkedIn, now]);

  const requiresRemark = !checkedIn ? predictedLate > 0 : predictedEarlyOut > 0;

  useEffect(() => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setGeoError("Geolocation not supported on this device.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setGeoError(null);
      },
      (err) => {
        setGeoError(err.message || "Location permission denied or unavailable.");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  async function getFreshPosition(): Promise<GeoPosition | null> {
    if (typeof window === "undefined" || !("geolocation" in navigator)) return position;
    setLocating(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 0,
        });
      });
      const fresh: GeoPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      setPosition(fresh);
      setGeoError(null);
      return fresh;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unable to detect your location. Please enable GPS and try again.";
      setGeoError(msg);
      return position;
    } finally {
      setLocating(false);
    }
  }

  async function handleCheckIn() {
    setSubmitError(null);
    const fresh = await getFreshPosition();
    if (!fresh) {
      setSubmitError("Unable to detect your location — please enable GPS and try again.");
      return;
    }
    const zone = matchZone(fresh, zones);
    if (zones.length > 0 && !zone) {
      setSubmitError("You are outside the duty geofence. Move within an authorized station zone to check in.");
      return;
    }
    if (requiresRemark && !remark.trim()) {
      setSubmitError("Please add a remark before checking in.");
      return;
    }
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const outcome = await submitCheckIn({
      lat: fresh.lat,
      lng: fresh.lng,
      accuracy: fresh.accuracy,
      inside_fence: !!zone,
      zone_id: zone?.id,
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
    const fresh = await getFreshPosition();
    if (!fresh) {
      setSubmitError("Unable to detect your location — please enable GPS and try again.");
      return;
    }
    const zone = matchZone(fresh, zones);
    if (zones.length > 0 && !zone) {
      setSubmitError("You are outside the duty geofence. Move within an authorized station zone to check out.");
      return;
    }
    if (requiresRemark && !remark.trim()) {
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

  // Same-day check for live compliance preview
  const isSelectedSameDay = useMemo(() => {
    return isSameDayLeave(startDate, today);
  }, [startDate, today]);

  const liveComplianceCalc = useMemo(() => {
    if (!isSelectedSameDay || !scheduled?.start) return null;
    return calculateAbsenceGap(scheduled.start, now);
  }, [isSelectedSameDay, scheduled, now]);

  async function handleApplyLeave() {
    setLeaveError(null);
    if (!leaveRemarks.trim()) {
      setLeaveError("Please enter remarks explaining the reason for your leave.");
      return;
    }
    if (endDate < startDate) {
      setLeaveError("End date cannot be earlier than start date.");
      return;
    }

    setSubmittingLeave(true);
    try {
      const result = await submitLeaveApplication({
        leaveType,
        startDate,
        endDate,
        remarks: leaveRemarks,
      });

      if (!result.success || result.error) {
        setLeaveError(result.error ?? "Failed to submit leave application.");
        return;
      }

      setLeaveRemarks("");
      setShowLeaveForm(false);

      if (result.submittedAt) {
        setLeaveNotice({
          id: "temp-" + Date.now(),
          user_id: "",
          staff_name: "",
          staff_id: null,
          role: "",
          station: null,
          team: null,
          ops_group: null,
          shift_code: roster?.shift_code ?? null,
          duty_date: today,
          leave_type: leaveType,
          start_date: startDate,
          end_date: endDate,
          shift_start_time: scheduled?.start ? scheduled.start.toISOString() : new Date().toISOString(),
          submitted_at: result.submittedAt,
          gap_minutes: result.status === "green" ? 180 : result.status === "red" ? 0 : null,
          status: result.status ?? null,
          approval_status: result.approvalStatus ?? "pending",
          reviewed_by: null,
          reviewed_at: null,
          review_notes: null,
          remarks: leaveRemarks,
          created_at: result.submittedAt,
        });
      }
      router.refresh();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "Unexpected error submitting leave application.");
    } finally {
      setSubmittingLeave(false);
    }
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
            LATE CHECKIN {record.late_minutes} MIN — {record.late_remark}
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
      {/* Existing Leave / Absence Notice banner */}
      {leaveNotice && (
        <div
          className={`vecta-panel space-y-2.5 border-l-4 ${
            leaveNotice.approval_status === "approved"
              ? "border-l-success bg-success/5"
              : leaveNotice.approval_status === "rejected"
                ? "border-l-brand bg-brand/5"
                : "border-l-warning bg-warning/5"
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display font-bold text-sm text-foreground flex items-center gap-1.5">
                <span>{LEAVE_TYPE_ICONS[leaveNotice.leave_type] || "🌴"}</span>
                {LEAVE_TYPE_LABELS[leaveNotice.leave_type] || leaveNotice.leave_type}
              </span>

              {/* Approval Badge */}
              <span
                className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                  leaveNotice.approval_status === "approved"
                    ? "bg-success/20 text-success border border-success/30"
                    : leaveNotice.approval_status === "rejected"
                      ? "bg-brand/20 text-brand border border-brand/30"
                      : "bg-warning/20 text-warning border border-warning/30"
                }`}
              >
                {leaveNotice.approval_status === "approved"
                  ? "✓ Approved by DSE"
                  : leaveNotice.approval_status === "rejected"
                    ? "✕ Rejected by DSE"
                    : "⏳ Pending DSE Review"}
              </span>

              {/* Same-day Compliance Timing Badge if applicable */}
              {leaveNotice.status && leaveNotice.gap_minutes !== null && (
                <span
                  className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-bold ${
                    leaveNotice.status === "green"
                      ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                  }`}
                >
                  {formatAbsenceGap(leaveNotice.gap_minutes)}
                </span>
              )}
            </div>

            <div className="font-mono text-xs text-muted-foreground">
              {leaveNotice.start_date === leaveNotice.end_date
                ? `Duty: ${leaveNotice.start_date}`
                : `${leaveNotice.start_date} → ${leaveNotice.end_date}`}
            </div>
          </div>

          <p className="text-[13px] font-medium text-foreground">
            &ldquo;{leaveNotice.remarks}&rdquo;
          </p>

          {leaveNotice.review_notes && (
            <div className="rounded bg-background/60 p-2 font-mono text-xs text-muted-foreground border border-border/50">
              <strong className="text-foreground">DSE Note:</strong> {leaveNotice.review_notes}
            </div>
          )}

          <p className="font-mono text-[10px] text-muted-foreground">
            Submitted at {formatDateTimeMY(leaveNotice.submitted_at)} · {leaveNotice.shift_code ?? "Shift"}
          </p>
        </div>
      )}

      <div className="vecta-panel overflow-hidden !p-0">
        <DutyMap
          position={position}
          zones={zones}
          insideZone={insideZone}
          locating={locating}
          station={zones[0]?.station}
        />
      </div>

      {checkedIn && (
        <div className="vecta-panel !py-4">
          <p className="vecta-eyebrow text-success">On duty since {formatTimeMY(record!.check_in_at)}</p>
        </div>
      )}

      {/* GPS Unavailable / Permission Required Banner */}
      {(!position || geoError) && (
        <div className="vecta-panel space-y-2 border-l-[3px] border-l-brand bg-brand/5">
          <div className="flex items-center justify-between">
            <p className="vecta-eyebrow text-brand flex items-center gap-1.5">
              <span>📍</span> Live GPS Required
            </p>
            <button
              type="button"
              onClick={() => getFreshPosition()}
              disabled={locating}
              className="text-[10px] font-mono font-semibold text-primary underline hover:text-primary/80 transition-colors"
            >
              {locating ? "Acquiring…" : "↻ Retry GPS"}
            </button>
          </div>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            {geoError ?? "Location services are required to verify your presence within the duty geofence. Please enable GPS on your device and grant location access to check in or out."}
          </p>
        </div>
      )}

      {/* Outside Geofence Warning Banner */}
      {position && !insideZone && zones.length > 0 && (
        <div className="vecta-panel space-y-1.5 border-l-[3px] border-l-warning bg-warning/5">
          <p className="vecta-eyebrow text-warning flex items-center gap-1.5">
            <span>⚠️</span> Outside Station Geofence
          </p>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            Your current GPS position is outside {zones[0]?.station || "station"} duty zone boundaries. You must be physically inside a designated zone to {checkedIn ? "check out" : "check in"}.
          </p>
        </div>
      )}

      {/* Remark input if early / late checkin or checkout */}
      {requiresRemark && (
        <div className="vecta-panel space-y-2 !py-4">
          <p className="vecta-label">
            {!checkedIn
              ? predictedLate > 0
                ? "Checking in late — explanation required"
                : "Checking in early — explanation required"
              : predictedEarlyOut > 0
                ? "Checking out early — explanation required"
                : "Checking out late — explanation required"}
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

      {/* Consolidated Apply Leave Modal / Form */}
      {showLeaveForm && !checkedIn && (
        <div className="vecta-panel space-y-3.5 !border-primary/50 bg-primary/5 !py-4">
          <div className="flex items-center justify-between border-b border-border/40 pb-2.5">
            <p className="vecta-label !text-primary flex items-center gap-1.5">
              <span>🌴</span> APPLY LEAVE / REPORT ABSENCE
            </p>
            {isSelectedSameDay && liveComplianceCalc && (
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${
                  liveComplianceCalc.status === "green"
                    ? "bg-success/20 text-success border border-success/40"
                    : "bg-brand/20 text-brand border border-brand/40"
                }`}
              >
                {liveComplianceCalc.status === "green" ? "🟢 Compliant (≥3H)" : "🔴 Late Notice (<3H)"}
              </span>
            )}
            {!isSelectedSameDay && (
              <span className="rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider bg-secondary text-foreground border border-border">
                Advance Planned Leave
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div>
              <label className="vecta-label">Leave Type</label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value as LeaveType)}
                className="vecta-input"
              >
                {LEAVE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LEAVE_TYPE_ICONS[t]} {LEAVE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="vecta-label">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
                className="vecta-input"
              />
            </div>

            <div>
              <label className="vecta-label">End Date</label>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="vecta-input"
              />
            </div>
          </div>

          <p className="text-[12px] text-muted-foreground">
            {isSelectedSameDay
              ? `Same-day application: Server captures submission timestamp. Notice gap: ${liveComplianceCalc?.formattedGap ?? "calculating..."}.`
              : `Advance leave from ${startDate} to ${endDate}. Will be logged and submitted to DSE for approval.`}
          </p>

          <div className="space-y-1.5">
            <label className="vecta-label">Reason / Explanation (Required):</label>
            <textarea
              className="vecta-input h-auto py-2.5"
              rows={3}
              value={leaveRemarks}
              onChange={(e) => setLeaveRemarks(e.target.value)}
              placeholder="State reason for leave (e.g. informed DSE via phone, medical unwell, personal emergency)..."
            />
            <QuickPhrases
              value={leaveRemarks}
              onChange={setLeaveRemarks}
              phrases={LEAVE_PHRASES}
            />
          </div>

          {leaveError && <p className="font-mono text-[11px] text-brand">{leaveError}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="btn-secondary flex-1 py-2 text-xs"
              onClick={() => {
                setShowLeaveForm(false);
                setLeaveError(null);
              }}
              disabled={submittingLeave}
            >
              Cancel
            </button>
            <button
              type="button"
              className="vecta-btn-primary flex-1 py-2 text-xs"
              onClick={handleApplyLeave}
              disabled={submittingLeave || !leaveRemarks.trim()}
            >
              {submittingLeave ? "Submitting…" : "Confirm & Submit Leave"}
            </button>
          </div>
        </div>
      )}

      {submitError && <p className="font-mono text-[11px] text-brand">{submitError}</p>}

      {/* Primary Action Buttons */}
      <div className="flex flex-col sm:flex-row gap-2.5">
        <button
          type="button"
          className="vecta-btn-primary flex-1"
          disabled={submitting || locating || !position || zoneBlocked}
          onClick={checkedIn ? handleCheckOut : handleCheckIn}
        >
          {submitting
            ? "Submitting…"
            : locating
              ? "Confirming your location…"
              : !position
                ? "GPS Location Required"
                : zoneBlocked
                  ? `Move to duty zone to ${checkedIn ? "check out" : "check in"}`
                  : checkedIn
                    ? "Check out"
                    : "Check in"}
        </button>

        {/* Apply Leave button is disabled / hidden once checked in for the shift */}
        {!checkedIn && !showLeaveForm && (
          <button
            type="button"
            className="rounded-xl border border-primary/50 bg-primary/10 hover:bg-primary/20 px-4 py-3 font-mono text-xs font-semibold uppercase tracking-wider text-primary transition-colors flex items-center justify-center gap-1.5"
            onClick={() => setShowLeaveForm(true)}
          >
            <span>🌴</span> Apply Leave
          </button>
        )}
      </div>
    </div>
  );
}
