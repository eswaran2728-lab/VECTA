"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * AVSEC crest (top-left) and AirAsia wordmark (top-right) on the login
 * screen. Reads /public/avsec-logo.png and /public/airasia-logo.png —
 * silently omits either logo if the file hasn't been supplied yet.
 */
export function PartnerLogos() {
  const [avsecOk, setAvsecOk] = useState(true);
  const [airasiaOk, setAirasiaOk] = useState(true);

  if (!avsecOk && !airasiaOk) return null;

  return (
    <div className="mx-auto flex w-full max-w-sm items-center justify-between pt-2">
      {avsecOk ? (
        <Image
          src="/avsec-logo.png"
          alt="AVSEC"
          width={64}
          height={64}
          className="h-12 w-auto object-contain"
          onError={() => setAvsecOk(false)}
        />
      ) : (
        <span />
      )}
      {airasiaOk ? (
        <Image
          src="/airasia-logo.png"
          alt="AirAsia"
          width={96}
          height={40}
          className="h-9 w-auto object-contain"
          onError={() => setAirasiaOk(false)}
        />
      ) : (
        <span />
      )}
    </div>
  );
}
