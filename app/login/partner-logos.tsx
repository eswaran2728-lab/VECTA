"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * AVSEC crest + AirAsia wordmark hero lockup — the primary brand mark on
 * the login/register screens (replaces a generic app icon). Reads
 * /public/avsec-logo.png and /public/airasia-logo.png — silently omits
 * either logo if the file hasn't been supplied yet.
 */
export function PartnerLogos() {
  const [avsecOk, setAvsecOk] = useState(true);
  const [airasiaOk, setAirasiaOk] = useState(true);

  if (!avsecOk && !airasiaOk) return null;

  return (
    <div className="flex items-center justify-center gap-[26px]">
      {avsecOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "0ms" }}>
          <div
            className="animate-float drop-shadow-[0_0_14px_oklch(0.78_0.14_220_/_0.4)]"
            style={{ animationDelay: "0ms" }}
          >
            <Image
              src="/avsec-logo.png"
              alt="AVSEC"
              width={160}
              height={160}
              priority
              className="h-[52px] w-auto object-contain"
              onError={() => setAvsecOk(false)}
            />
          </div>
        </div>
      ) : null}
      {avsecOk && airasiaOk ? <div className="h-[34px] w-px bg-border" /> : null}
      {airasiaOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "150ms" }}>
          <div
            className="animate-float"
            style={{ animationDelay: "600ms", animationDuration: "5.5s" }}
          >
            <Image
              src="/airasia-logo.png"
              alt="AirAsia"
              width={240}
              height={240}
              priority
              className="h-[30px] w-auto object-contain"
              onError={() => setAirasiaOk(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
