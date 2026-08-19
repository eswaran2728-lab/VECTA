"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Nav-bar AirAsia wordmark, shown beside the AVSEC brand mark. Reads
 * /public/airasia-logo.png — silently omits itself if not supplied.
 */
export function AirAsiaMark() {
  const [logoOk, setLogoOk] = useState(true);
  if (!logoOk) return null;

  return (
    <Image
      src="/airasia-logo.png"
      alt="AirAsia"
      width={96}
      height={96}
      className="hidden h-6 w-6 object-contain sm:block"
      onError={() => setLogoOk(false)}
    />
  );
}
