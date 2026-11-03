"use client";

import { useRouter } from "next/navigation";
import { HandoverQrPanel } from "./HandoverQrPanel";
import { HandoverScanPanel } from "./HandoverScanPanel";

export function HandoverSenderActions({ handoverId }: { handoverId: string }) {
  const router = useRouter();
  return <HandoverQrPanel handoverId={handoverId} onCompleted={() => router.refresh()} />;
}

export function HandoverRecipientActions({ handoverId }: { handoverId: string }) {
  const router = useRouter();
  return <HandoverScanPanel handoverId={handoverId} onDone={() => router.refresh()} />;
}
