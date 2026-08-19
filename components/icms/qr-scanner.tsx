"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/icms/ui/button";
import { Input } from "@/components/icms/ui/input";
import { Label } from "@/components/icms/ui/label";

const REGION_ID = "cscs-qr-reader";

/**
 * Camera-first QR scanner. Every scan is validated server-side (signature,
 * expiry, workflow order); when the transaction is waiting on the signed-in
 * officer's own checkpoint, they land directly on their verification form,
 * otherwise on the read-only transaction detail. Manual entry accepts a
 * transaction number and goes through the same validation endpoint.
 */
export function QrScanner() {
  const router = useRouter();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);
  const [looking, setLooking] = useState(false);

  const resolveAndGo = async (query: string): Promise<void> => {
    setLooking(true);
    setError(null);
    try {
      const res = await fetch(`/api/icms/qr/validate?${query}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Pass could not be validated.");
        handledRef.current = false;
        return;
      }
      scannerRef.current?.stop().catch(() => undefined);
      router.push(body.redirectPath ?? `/transactions/${body.transactionId}`);
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
      let token: string | null = null;
      try {
        const parsed = JSON.parse(decodedText);
        if (typeof parsed?.t === "string") token = parsed.t;
      } catch {
        // not JSON
      }
      if (!token) {
        setError(
          "Not a valid ICMS QR pass (old or unsigned passes are rejected — use manual entry)."
        );
        return;
      }
      handledRef.current = true;
      void resolveAndGo(`token=${encodeURIComponent(token)}`);
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
    const trimmed = manual.trim().toUpperCase();
    if (!trimmed) return;
    void resolveAndGo(`number=${encodeURIComponent(trimmed)}`);
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
        <p className="text-center text-sm text-muted-foreground">Validating pass…</p>
      ) : null}
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}

      <form onSubmit={handleManual} className="mx-auto flex max-w-md flex-col gap-2">
        <Label htmlFor="manual-entry">Manual entry</Label>
        <div className="flex gap-2">
          <Input
            id="manual-entry"
            placeholder="Transaction number e.g. ICMS-2026-000001"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={looking}>
            Find
          </Button>
        </div>
      </form>
    </div>
  );
}
