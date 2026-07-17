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
    <div className="mx-auto flex w-full max-w-sm items-center justify-between px-1 pt-2">
      {avsecOk ? (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pl-1.5 pr-3 backdrop-blur-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 ring-1 ring-white/10">
            <Image
              src="/avsec-logo.png"
              alt="AVSEC"
              width={64}
              height={64}
              className="h-7 w-7 object-contain"
              onError={() => setAvsecOk(false)}
            />
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
            AVSEC
          </span>
        </div>
      ) : (
        <span />
      )}
      {airasiaOk ? (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pl-3 pr-1.5 backdrop-blur-sm">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
            Partner
          </span>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 ring-1 ring-white/10">
            <Image
              src="/airasia-logo.png"
              alt="AirAsia"
              width={96}
              height={96}
              className="h-7 w-7 object-contain"
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
