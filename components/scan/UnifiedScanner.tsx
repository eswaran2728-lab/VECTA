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
    <div className="flex flex-col gap-5">
      {/* Glass viewfinder frame — cyan corner-node reticle + horizontal scan
          beam are purely decorative overlays on top of the real camera feed
          rendered into #REGION_ID by html5-qrcode; none of the scan logic
          below was touched. */}
      <div className="vecta-panel relative aspect-square overflow-hidden !rounded-[20px] !p-0">
        <div
          id={REGION_ID}
          className="absolute inset-0 h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover"
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "radial-gradient(ellipse at 50% 40%, oklch(0.62 0.2 300 / 0.16), transparent 65%)",
          }}
        />
        <div
          className="pointer-events-none absolute left-0 right-0 top-[42%] h-0.5"
          style={{
            background: "linear-gradient(90deg, transparent, var(--cyan), transparent)",
            boxShadow: "0 0 12px 2px var(--cyan)",
          }}
        />
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[62%] w-[62%] -translate-x-1/2 -translate-y-1/2">
          <span className="absolute left-0 top-0 h-[30px] w-[30px] rounded-tl-lg border-l-[1.5px] border-t-[1.5px] border-primary" />
          <span className="absolute right-0 top-0 h-[30px] w-[30px] rounded-tr-lg border-r-[1.5px] border-t-[1.5px] border-primary" />
          <span className="absolute bottom-0 left-0 h-[30px] w-[30px] rounded-bl-lg border-b-[1.5px] border-l-[1.5px] border-primary" />
          <span className="absolute bottom-0 right-0 h-[30px] w-[30px] rounded-br-lg border-b-[1.5px] border-r-[1.5px] border-primary" />
          {[
            { top: "-2.5px", left: "-2.5px" },
            { top: "-2.5px", right: "-2.5px" },
            { bottom: "-2.5px", left: "-2.5px" },
            { bottom: "-2.5px", right: "-2.5px" },
          ].map((pos, i) => (
            <span
              key={i}
              className="absolute h-[5px] w-[5px] rounded-full bg-primary"
              style={{ ...pos, boxShadow: "0 0 6px 1px var(--cyan)" }}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-4 text-center">
          <span className="vecta-eyebrow">
            {!scanning && !error ? "Starting camera…" : looking ? "Validating…" : "Align QR within frame"}
          </span>
        </div>
      </div>

      {error ? (
        <div
          className="vecta-panel !rounded-2xl px-[18px] py-4"
          style={{
            borderColor: "oklch(0.6 0.2 25 / 0.5)",
            boxShadow: "0 0 30px -10px oklch(0.6 0.2 25 / 0.3)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{ background: "var(--red)", boxShadow: "0 0 8px 1px var(--red)" }}
            />
            <span className="font-display text-sm font-bold tracking-[0.02em] text-brand">
              SCAN ERROR
            </span>
          </div>
          <p className="mt-2 font-mono text-[12.5px] text-muted-foreground">{error}</p>
        </div>
      ) : null}

      <form onSubmit={handleManual} className="vecta-panel !rounded-2xl flex flex-col gap-2 px-[18px] py-4">
        <label htmlFor="unified-scan-manual" className="vecta-label !mb-0">
          Manual entry
        </label>
        <div className="flex gap-2">
          <input
            id="unified-scan-manual"
            className="vecta-input flex-1"
            placeholder="Transaction reference"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            type="submit"
            disabled={looking}
            className="h-[46px] shrink-0 rounded-[10px] bg-gradient-to-r from-primary to-[var(--violet)] px-5 font-sans text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Find
          </button>
        </div>
      </form>
    </div>
  );
}
