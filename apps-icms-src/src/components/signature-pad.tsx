"use client";

import { useEffect, useRef, useState } from "react";
import SignaturePad from "signature_pad";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface SignatureFieldProps {
  label?: string;
  onChange: (dataUrl: string | null) => void;
}

/**
 * Canvas signature capture. Emits a PNG data URL whenever the
 * signature changes; null when cleared/empty.
 */
export function SignatureField({ label = "Signature", onChange }: SignatureFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = padRef.current?.toData();
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      if (padRef.current && data) padRef.current.fromData(data);
    };

    const pad = new SignaturePad(canvas, {
      penColor: "#111827",
      backgroundColor: "rgba(255,255,255,1)",
    });
    padRef.current = pad;
    resize();
    window.addEventListener("resize", resize);

    const handleEnd = () => {
      const empty = pad.isEmpty();
      setIsEmpty(empty);
      onChange(empty ? null : pad.toDataURL("image/png"));
    };
    pad.addEventListener("endStroke", handleEnd);

    return () => {
      window.removeEventListener("resize", resize);
      pad.off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = () => {
    padRef.current?.clear();
    setIsEmpty(true);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={isEmpty}>
          Clear
        </Button>
      </div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full touch-none rounded-md border border-input bg-white"
        aria-label="Signature area - sign with finger or stylus"
      />
      <p className="text-xs text-muted-foreground">
        Sign inside the box using your finger or a stylus.
      </p>
    </div>
  );
}
