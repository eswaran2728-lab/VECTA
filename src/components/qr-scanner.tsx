"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseQrPayload } from "@/lib/utils";

const REGION_ID = "cscs-qr-reader";

/**
 * Camera QR scanner with manual fallback (transaction number lookup is
 * handled by the /scan page action). On successful scan it routes to the
 * transaction detail page, which shows the correct next checkpoint.
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

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          if (handledRef.current) return;
          const id = parseQrPayload(decodedText);
          if (id) {
            handledRef.current = true;
            scanner.stop().catch(() => undefined);
            router.push(`/transactions/${id}`);
          } else {
            setError("QR code is not a CSCS transaction pass.");
          }
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

  const handleManual = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manual.trim();
    if (!trimmed) return;
    const id = parseQrPayload(trimmed);
    if (id) {
      router.push(`/transactions/${id}`);
    } else {
      // Treat as a transaction number lookup.
      router.push(`/transactions?q=${encodeURIComponent(trimmed)}`);
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
