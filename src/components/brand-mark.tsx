"use client";

import { useState } from "react";
import Image from "next/image";
import { ShieldCheck } from "lucide-react";

/**
 * Nav-bar brand mark: AVSEC crest when /public/avsec-logo.png is supplied,
 * falling back to the generic shield icon so the app never breaks without it.
 */
export function BrandMark() {
  const [logoOk, setLogoOk] = useState(true);

  if (logoOk) {
    return (
      <Image
        src="/avsec-logo.png"
        alt="AVSEC"
        width={28}
        height={28}
        className="h-7 w-7 object-contain"
        onError={() => setLogoOk(false)}
      />
    );
  }
  return <ShieldCheck className="h-6 w-6 text-primary" />;
}
