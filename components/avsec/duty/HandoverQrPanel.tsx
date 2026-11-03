"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { issueHandoverChallenge, pushHandoverSenderLocation } from "@/lib/avsec/duty/handover-actions";

/** Outgoing officer: shows a single-use 60-second QR and keeps pushing a fresh location while it is on screen. */
export function HandoverQrPanel({ handoverId, onCompleted }: { handoverId: string; onCompleted: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expiresAtMs = useRef(0);
  const watch = useRef<number | null>(null);

  const stopWatch = () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
  };

  const show = useCallback(async () => {
    setError(null);
    setStatus(null);
    const r = await issueHandoverChallenge(handoverId);
    if (!r.ok) return setError(r.error);
    setDataUrl(await QRCode.toDataURL(r.payload, { width: 260, margin: 2, errorCorrectionLevel: "M" }));
    expiresAtMs.current = Date.parse(r.expiresAt);
    stopWatch();
    if (!navigator.geolocation) return setError("This device cannot provide a location.");
    watch.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const res = await pushHandoverSenderLocation(handoverId, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        if (!res.ok) setError(res.error);
        else setStatus(`Location shared (±${Math.round(pos.coords.accuracy)} m). Keep this screen open.`);
      },
      () => setError("Location is off or blocked. Turn it on to hand over in person."),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }, [handoverId]);

  useEffect(() => {
    const t = setInterval(() => {
      if (expiresAtMs.current === 0) return;
      const left = Math.max(0, Math.ceil((expiresAtMs.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0 && watch.current !== null) {
        stopWatch();
        onCompleted();
      }
    }, 500);
    return () => {
      clearInterval(t);
      stopWatch();
    };
  }, [onCompleted]);

  return (
    <div className="border-t border-border/50 pt-3 space-y-2 text-center">
      {dataUrl && secondsLeft > 0 ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="Handover QR code" width={260} height={260} className="mx-auto rounded bg-white" />
          <p className="font-mono text-xs text-muted-foreground">Valid for {secondsLeft}s · single use. The receiving officer scans this.</p>
        </>
      ) : (
        <button type="button" className="btn-primary w-full text-xs" onClick={show}>
          {dataUrl ? "Show a new QR code ▸" : "Show QR code to the receiving officer ▸"}
        </button>
      )}
      {status && <p className="font-mono text-[11px] text-success">{status}</p>}
      {error && <p className="text-xs text-destructive font-mono">{error}</p>}
    </div>
  );
}
