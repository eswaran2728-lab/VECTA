"use client";

import { useEffect, useRef, useState } from "react";
import { BarcodeDetector } from "barcode-detector/pure";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, X } from "lucide-react";

interface SealBarcodeScannerProps {
  /** Called with the decoded barcode text; parent closes the scanner. */
  onDetected: (value: string) => void;
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

/**
 * Camera-first barcode scanner for physical seal tags (CODE_128/CODE_39
 * printed alongside the human-readable seal number).
 *
 * Decodes via the `barcode-detector` package (a WebAssembly build of the
 * real ZXing-C++ library) instead of html5-qrcode/the native
 * BarcodeDetector API — those depend on browser support that's missing or
 * weak for 1D formats on WebKit (iPhone Safari *and* iPhone Chrome, which
 * is WebKit underneath), so this gives the same decode engine and
 * accuracy on every platform. Only the .wasm decoder itself is fetched
 * (once, from jsDelivr by default) — every scan afterwards is local, no
 * per-scan network call, and every other part of this workflow already
 * assumes network connectivity.
 */
export function SealBarcodeScanner({ onDetected, onClose }: SealBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const activeRef = useRef(true);
  const handledRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomSupported, setZoomSupported] = useState(false);

  useEffect(() => {
    activeRef.current = true;
    handledRef.current = false;
    detectorRef.current = new BarcodeDetector({
      formats: ["code_128", "code_39", "codabar"],
    });

    const scanLoop = async (video: HTMLVideoElement) => {
      if (!activeRef.current || handledRef.current) return;
      if (video.readyState >= 2) {
        try {
          const barcodes = await detectorRef.current!.detect(video);
          if (barcodes.length > 0) {
            handledRef.current = true;
            onDetectedRef.current(barcodes[0].rawValue.trim());
            return;
          }
        } catch {
          // per-frame decode misses/errors are expected
        }
      }
      if (activeRef.current && !handledRef.current) {
        requestAnimationFrame(() => void scanLoop(video));
      }
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          },
        });
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setScanning(true);

        // Zoom capability varies by device — probe after the stream starts.
        try {
          const caps = stream.getVideoTracks()[0]?.getCapabilities() as
            | (MediaTrackCapabilities & { zoom?: { min: number; max: number } })
            | undefined;
          if (caps?.zoom) setZoomSupported(true);
        } catch {
          // capability probing not supported on this browser — zoom controls just won't show
        }

        requestAnimationFrame(() => void scanLoop(video));
      } catch {
        setError("Camera unavailable. Close this and type the seal number instead.");
      }
    })();

    return () => {
      activeRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // Deliberately mount-once: onDetected is read via a ref (kept fresh
    // above) so the camera/decoder aren't torn down and rebuilt on every
    // parent re-render.
  }, []);

  const applyZoom = async (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    setZoom(clamped);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      await track?.applyConstraints({
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

      <div className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border bg-black/90">
        <video ref={videoRef} playsInline muted autoPlay className="w-full" />
      </div>

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
