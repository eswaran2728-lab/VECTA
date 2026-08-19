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
    <div className="flex items-center justify-center gap-6 sm:gap-8">
      {avsecOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "0ms" }}>
          <div
            className="animate-float drop-shadow-[0_0_32px_rgba(212,175,55,0.5)]"
            style={{ animationDelay: "0ms" }}
          >
            <Image
              src="/avsec-logo.png"
              alt="AVSEC"
              width={160}
              height={160}
              priority
              className="h-28 w-28 object-contain sm:h-32 sm:w-32"
              onError={() => setAvsecOk(false)}
            />
          </div>
        </div>
      ) : null}
      {airasiaOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "150ms" }}>
          <div
            className="animate-float drop-shadow-[0_0_32px_rgba(238,46,36,0.5)]"
            style={{ animationDelay: "600ms", animationDuration: "5.5s" }}
          >
            <Image
              src="/airasia-logo.png"
              alt="AirAsia"
              width={240}
              height={240}
              priority
              className="h-24 w-auto object-contain sm:h-28"
              onError={() => setAirasiaOk(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
