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
    <div className="mx-auto flex w-full max-w-md items-center justify-between px-2 pt-4">
      {avsecOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "0ms" }}>
          <div
            className="animate-float drop-shadow-[0_0_28px_rgba(212,175,55,0.45)]"
            style={{ animationDelay: "0ms" }}
          >
            <Image
              src="/avsec-logo.png"
              alt="AVSEC"
              width={128}
              height={128}
              priority
              className="h-20 w-20 object-contain sm:h-24 sm:w-24"
              onError={() => setAvsecOk(false)}
            />
          </div>
        </div>
      ) : (
        <span />
      )}
      {airasiaOk ? (
        <div className="animate-fade-in-up" style={{ animationDelay: "150ms" }}>
          <div
            className="animate-float drop-shadow-[0_0_28px_rgba(238,46,36,0.45)]"
            style={{ animationDelay: "600ms", animationDuration: "5.5s" }}
          >
            <Image
              src="/airasia-logo.png"
              alt="AirAsia"
              width={192}
              height={192}
              priority
              className="h-16 w-auto object-contain sm:h-20"
              onError={() => setAirasiaOk(false)}
            />
          </div>
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}
