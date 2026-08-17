"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, X } from "lucide-react";

interface SealBarcodeScannerProps {
  /** Called with the decoded barcode text; parent closes the scanner. */
  onDetected: (value: string) => void;
  onClose: () => void;
}

const REGION_ID = "seal-barcode-reader";
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

/**
 * Camera-first barcode scanner for physical seal tags (CODE_128/CODE_39
 * printed alongside the human-readable seal number). Purely client-side
 * decode, no network call — the decoded text is handed back to whatever
 * seal-number field opened the scanner, exactly as if it had been typed.
 */
export function SealBarcodeScanner({ onDetected, onClose }: SealBarcodeScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomSupported, setZoomSupported] = useState(false);

  useEffect(() => {
    const scanner = new Html5Qrcode(REGION_ID, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.CODABAR,
      ],
      verbose: false,
    });
    scannerRef.current = scanner;

    const handleDecoded = (decodedText: string) => {
      if (handledRef.current) return;
      handledRef.current = true;
      scanner.stop().catch(() => undefined);
      onDetected(decodedText.trim());
    };

    scanner
      .start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 280, height: 120 }, // wide box — seal barcodes are 1D, landscape
          aspectRatio: 1.7777,
        },
        handleDecoded,
        () => undefined // per-frame decode misses are expected
      )
      .then(() => {
        setScanning(true);
        // Zoom capability varies by device — probe after the stream starts.
        try {
          const caps = scanner.getRunningTrackCapabilities();
          // 'zoom' isn't in the standard MediaTrackCapabilities TS type yet;
          // browsers that support it still expose it at runtime.
          if ((caps as MediaTrackCapabilities & { zoom?: { min: number; max: number } }).zoom) {
            setZoomSupported(true);
          }
        } catch {
          // capability probing not supported on this browser — zoom controls just won't show
        }
      })
      .catch(() =>
        setError("Camera unavailable. Close this and type the seal number instead.")
      );

    return () => {
      const s = scannerRef.current;
      if (s && s.isScanning) s.stop().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyZoom = async (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(clamped);
    try {
      await scannerRef.current?.applyVideoConstraints({
        advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
      });
    } catch {
      // device doesn't actually support runtime zoom changes despite capability probe
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Scan seal barcode</p>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close scanner">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div
        id={REGION_ID}
        className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border bg-black/90 [&_video]:w-full"
      />

      {!scanning && !error ? (
        <p className="text-center text-sm text-muted-foreground">Starting camera…</p>
      ) : null}
      {error ? <p className="text-center text-sm text-red-600">{error}</p> : null}

      {zoomSupported ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => applyZoom(zoom - ZOOM_STEP)}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center font-mono text-sm">{zoom.toFixed(1)}×</span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => applyZoom(zoom + ZOOM_STEP)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        Hold steady, fill the frame with the barcode. Small/worn tags may need zoom.
      </p>
    </div>
  );
}
