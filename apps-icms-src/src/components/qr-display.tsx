"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface QrDisplayProps {
  /** Signed HMAC token generated server-side; expires after 24 hours. */
  token: string;
  transactionNumber: string;
  size?: number;
}

/**
 * Renders the transaction QR pass. Payload: {"t":"<signed token>"} — the same
 * code is scanned at every checkpoint and validated server-side (signature,
 * expiry, and workflow order) before any checkpoint page is shown.
 */
export function QrDisplay({ token, transactionNumber, size = 240 }: QrDisplayProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    QRCode.toDataURL(JSON.stringify({ t: token }), {
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [token, size]);

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border bg-white p-4">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt={`QR code for ${transactionNumber}`} width={size} height={size} />
      ) : (
        <div
          className="flex items-center justify-center bg-gray-100 text-sm text-gray-500"
          style={{ width: size, height: size }}
        >
          Generating QR…
        </div>
      )}
      <p className="font-mono text-sm font-semibold text-gray-900">{transactionNumber}</p>
      <button
        type="button"
        onClick={() => window.print()}
        className="text-xs text-blue-600 underline print:hidden"
      >
        Print QR pass
      </button>
    </div>
  );
}
