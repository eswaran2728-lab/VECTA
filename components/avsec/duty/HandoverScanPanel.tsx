"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { stopScannerSafely } from "@/lib/icms/scanner-stop";
import { completeHandover } from "@/lib/avsec/duty/handover-actions";

const REGION = "handover-scan-region";

/** Receiving officer: scans the QR, captures a fresh location, and completes the handover in one server transaction. */
export function HandoverScanPanel({ handoverId, onDone }: { handoverId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scanner = useRef<Html5Qrcode | null>(null);
  const handled = useRef(false);

  const finish = async (payload: string) => {
    if (handled.current) return;
    const m = /^VECTA-HO:([0-9a-f-]{36}):([0-9a-f]{64})$/i.exec(payload.trim());
    if (!m || m[1].toLowerCase() !== handoverId.toLowerCase()) {
      setMessage("This QR code is not for this handover.");
      return;
    }
    handled.current = true;
    setBusy(true);
    await stopScannerSafely(scanner.current);
    if (!navigator.geolocation) {
      setBusy(false);
      handled.current = false;
      setMessage("This device cannot provide a location.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const r = await completeHandover(
          handoverId,
          m[2],
          { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, capturedAt: new Date(pos.timestamp).toISOString() },
          notes,
        );
        setBusy(false);
        if (r.ok) {
          setMessage("Handover completed.");
          onDone();
          return;
        }
        handled.current = false;
        setMessage(r.error);
      },
      () => {
        setBusy(false);
        handled.current = false;
        setMessage("Location is off or blocked. Turn it on and scan again.");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  };

  useEffect(() => {
    if (!open) return;
    const s = new Html5Qrcode(REGION);
    scanner.current = s;
    s.start({ facingMode: "environment" }, { fps: 8, qrbox: 240 }, (text) => void finish(text), () => {}).catch(() =>
      setMessage("The camera could not be started. Allow camera access and try again."),
    );
    return () => {
      void stopScannerSafely(s);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="border-t border-border/50 pt-3 space-y-2">
      <label className="field-label" htmlFor={`ho-notes-${handoverId}`}>
        Acknowledgment notes (optional)
      </label>
      <textarea id={`ho-notes-${handoverId}`} rows={2} className="input-base text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {open ? (
        <div id={REGION} className="mx-auto w-full max-w-xs" />
      ) : (
        <button
          type="button"
          className="btn-primary w-full text-xs"
          onClick={() => {
            handled.current = false;
            setMessage(null);
            setOpen(true);
          }}
        >
          Scan QR to receive handover ▸
        </button>
      )}
      {busy && <p className="font-mono text-xs text-muted-foreground">Verifying…</p>}
      {message && <p className="text-xs font-mono text-foreground">{message}</p>}
      <p className="font-mono text-[10px] text-muted-foreground">Both of you must be on duty, inside a station duty zone, within 50 m of each other, with location on.</p>
    </div>
  );
}
