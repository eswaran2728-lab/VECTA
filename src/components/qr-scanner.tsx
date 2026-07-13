"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REGION_ID = "cscs-qr-reader";

/**
 * Camera QR scanner with manual fallback (transaction number lookup is
 * handled by the signed validation endpoint). On success it routes directly
 * to the checkpoint assigned to the logged-in role when the handoff is ready.
 */
export function QrScanner() {
  const router = useRouter();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const scanner = new Html5Qrcode(REGION_ID);
    scannerRef.current = scanner;

    const handleDecoded = async (decodedText: string) => {
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
          "Not a valid CSCS QR pass (old or unsigned passes are rejected — use manual entry)."
        );
        return;
      }

      handledRef.current = true;
      try {
        const res = await fetch(`/api/qr/validate?token=${encodeURIComponent(token)}`);
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "QR pass could not be validated.");
          handledRef.current = false;
          return;
        }
        scanner.stop().catch(() => undefined);
        router.push(body.redirectPath ?? `/transactions/${body.transactionId}`);
      } catch {
        setError("Validation failed — check your connection and try again.");
        handledRef.current = false;
      }
    };

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          void handleDecoded(decodedText);
        },
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
  }, [router]);

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manual.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const res = await fetch(`/api/qr/validate?number=${encodeURIComponent(trimmed)}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Transaction could not be found.");
        return;
      }
      router.push(body.redirectPath ?? `/transactions/${body.transactionId}`);
    } catch {
      setError("Lookup failed — check your connection and try again.");
    }
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
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}

      <form onSubmit={handleManual} className="mx-auto flex max-w-md flex-col gap-2">
        <Label htmlFor="manual-entry">Manual entry</Label>
        <div className="flex gap-2">
          <Input
            id="manual-entry"
            placeholder="Transaction number e.g. CSCS-2026-000001"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <Button type="submit" variant="secondary">
            Find
          </Button>
        </div>
      </form>
    </div>
  );
}
