"use client";

import { useEffect, useRef, useState } from "react";
import { BarcodeDetector, setZXingModuleOverrides } from "barcode-detector/pure";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, X } from "lucide-react";

// Self-host the ~1MB decoder .wasm from this app's own origin instead of
// the package's default jsDelivr CDN fetch (public/wasm/zxing_reader.wasm,
// copied from node_modules/zxing-wasm's matching version — see the
// zxing-wasm dependency pin in package.json if that ever needs updating).
// Airport/enterprise networks at checkpoints often block third-party CDNs
// outright, which silently starves every detect() call forever — exactly
// the "keeps scanning, never finds anything" symptom this fixes. Runs
// once at module load, before any BarcodeDetector is constructed.
setZXingModuleOverrides({ locateFile: (path) => `/wasm/${path}` });

interface SealBarcodeScannerProps {
  /** Called with the decoded barcode text; parent closes the scanner. */
  onDetected: (value: string) => void;
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

// Scan-box region as a fraction of the displayed video — wide/short,
// matching the shape of a 1D barcode strip. The overlay box below is
// drawn at these exact same percentages, so what the officer sees lined
// up in the box is what actually gets cropped and decoded.
const CROP_WIDTH_PCT = 0.8;
const CROP_HEIGHT_PCT = 0.32;
const CROP_LEFT_PCT = (1 - CROP_WIDTH_PCT) / 2;
const CROP_TOP_PCT = (1 - CROP_HEIGHT_PCT) / 2;

// Decoding every animation frame is wasted work (battery/heat) without
// improving accuracy — throttle actual decode attempts.
const DECODE_FPS = 6;
const DECODE_INTERVAL_MS = 1000 / DECODE_FPS;

/**
 * Live camera-first barcode scanner for physical seal tags (CODE_128/
 * CODE_39 printed alongside the human-readable seal number).
 *
 * Decodes via the `barcode-detector` package (a WebAssembly build of the
 * real ZXing-C++ library) rather than the native BarcodeDetector API
 * (Safari has none, on iPhone or anywhere else) or html5-qrcode's weak
 * pure-JS fallback — same decode engine and accuracy on every platform.
 * Each tick crops the video down to just the visible scan-box region onto
 * an offscreen canvas before decoding, throttled to ~6/sec, rather than
 * running the decoder against the full camera frame on every frame.
 *
 * Only the .wasm decoder itself is fetched (once, self-hosted from this
 * app's own origin — see the setZXingModuleOverrides call above) — every
 * scan afterwards is local, no per-scan network call.
 */
export function SealBarcodeScanner({ onDetected, onClose }: SealBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastDecodeRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
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
    lastDecodeRef.current = 0;
    consecutiveErrorsRef.current = 0;
    detectorRef.current = new BarcodeDetector({
      formats: ["code_128", "code_39", "codabar"],
    });
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const scanLoop = async (video: HTMLVideoElement) => {
      if (!activeRef.current || handledRef.current) return;

      const now = performance.now();
      if (
        ctx &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        now - lastDecodeRef.current >= DECODE_INTERVAL_MS
      ) {
        lastDecodeRef.current = now;
        const sx = Math.round(video.videoWidth * CROP_LEFT_PCT);
        const sy = Math.round(video.videoHeight * CROP_TOP_PCT);
        const sw = Math.round(video.videoWidth * CROP_WIDTH_PCT);
        const sh = Math.round(video.videoHeight * CROP_HEIGHT_PCT);
        canvas.width = sw;
        canvas.height = sh;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

        try {
          const barcodes = await detectorRef.current!.detect(canvas);
          consecutiveErrorsRef.current = 0; // a clean resolve means the decoder is alive
          if (barcodes.length > 0) {
            handledRef.current = true;
            onDetectedRef.current(barcodes[0].rawValue.trim());
            return;
          }
        } catch (err) {
          // detect() rejecting is a real failure (decoder/wasm load
          // problem), not a "no barcode in this frame" miss — an empty
          // match resolves normally with barcodes.length === 0 instead.
          // A few isolated rejects can happen transiently; only give up
          // and surface an error once it's clearly not recovering.
          consecutiveErrorsRef.current += 1;
          console.error("Seal barcode decode failed:", err);
          if (consecutiveErrorsRef.current >= 5) {
            setError(
              "Barcode decoder failed to load — check your connection, or type the seal number instead."
            );
            activeRef.current = false;
            return;
          }
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

      <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-lg border bg-black/90">
        <video ref={videoRef} playsInline muted autoPlay className="w-full" />
        <div
          className="pointer-events-none absolute rounded-md border-2 border-amber-400"
          style={{
            left: `${CROP_LEFT_PCT * 100}%`,
            top: `${CROP_TOP_PCT * 100}%`,
            width: `${CROP_WIDTH_PCT * 100}%`,
            height: `${CROP_HEIGHT_PCT * 100}%`,
          }}
        />
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
        Line the barcode up inside the box. Small/worn tags may need zoom.
      </p>
    </div>
  );
}
