"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { scanTransaction } from "@/lib/icms/actions/scan";

const REGION_ID = "vecta-scan-reader";

/**
 * Camera-first QR scanner for the unified dashboard's Scan section. Reuses
 * the same html5-qrcode camera integration as the original ICMS scanner
 * (components/icms/qr-scanner.tsx), but decodes through the CaterLink
 * placeholder adapter (lib/icms/qr-payload.ts) and resolves through the
 * ops_group-scoped server action (lib/icms/actions/scan.ts) instead of the
 * ICMS-token-specific /api/icms/qr/validate route — this is the entry
 * point that's meant to work for so/aso/dse regardless of which ops_group
 * or origin table (profiles vs users) their account lives in.
 */
export function UnifiedScanner() {
  const router = useRouter();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);
  const [looking, setLooking] = useState(false);

  const resolveAndGo = async (raw: string): Promise<void> => {
    setLooking(true);
    setError(null);
    try {
      const result = await scanTransaction(raw);
      if (result.error || !result.redirectPath) {
        setError(result.error ?? "Could not resolve this transaction.");
        handledRef.current = false;
        return;
      }
      scannerRef.current?.stop().catch(() => undefined);
      router.push(result.redirectPath);
    } catch {
      setError("Validation failed — check your connection and try again.");
      handledRef.current = false;
    } finally {
      setLooking(false);
    }
  };

  useEffect(() => {
    const scanner = new Html5Qrcode(REGION_ID);
    scannerRef.current = scanner;

    const handleDecoded = (decodedText: string) => {
      if (handledRef.current) return;
      handledRef.current = true;
      void resolveAndGo(decodedText);
    };

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        handleDecoded,
        () => undefined // per-frame decode misses are expected
      )
      .then(() => setScanning(true))
      .catch(() =>
        setError("Camera unavailable. Use manual entry below or check camera permissions.")
      );

    return () => {
      const s = scannerRef.current;
      if (s && s.isScanning) s.stop().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const handleManual = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manual.trim();
    if (!trimmed) return;
    handledRef.current = true;
    void resolveAndGo(trimmed);
  };

  return (
    <div className="space-y-4">
      <div
        id={REGION_ID}
        className="mx-auto w-full max-w-md overflow-hidden rounded-lg border bg-black/90 [&_video]:w-full"
      />
      {!scanning && !error ? (
        <p className="text-center text-sm text-muted-foreground">Starting camera…</p>
      ) : null}
      {looking ? (
        <p className="text-center text-sm text-muted-foreground">Validating…</p>
      ) : null}
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}

      <form onSubmit={handleManual} className="mx-auto flex max-w-md flex-col gap-2">
        <label htmlFor="unified-scan-manual" className="text-sm font-medium">
          Manual entry
        </label>
        <div className="flex gap-2">
          <input
            id="unified-scan-manual"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Transaction reference"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            type="submit"
            disabled={looking}
            className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Find
          </button>
        </div>
      </form>
    </div>
  );
}
