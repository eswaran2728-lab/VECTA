"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadSatCombinedReportFile, replaceSatCombinedReportFile } from "@/lib/phase8/sat";

export function SatReportUploadForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await uploadSatCombinedReportFile(formData);
      if (!res.ok) {
        setError(res.error ?? "Upload failed.");
        return;
      }
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={handleSubmit} className="card p-4 space-y-2.5 border-border/80 bg-surface/80">
      <div className="font-mono text-xs font-bold text-foreground">Upload Combined Report (PDF)</div>
      <div className="grid grid-cols-2 gap-2">
        <input name="station" placeholder="Station (e.g. KUL - MAA)" className="input-base text-xs" required />
        <input name="team" placeholder="Team (e.g. Alpha)" className="input-base text-xs" required />
        <input name="operationalDate" type="date" className="input-base text-xs" required />
        <input name="shiftCoverage" placeholder="Shift coverage (e.g. Morning/Afternoon/Night)" className="input-base text-xs" required />
      </div>
      <input name="file" type="file" accept="application/pdf" className="input-base text-xs" required />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="submit" disabled={isPending} className="btn-primary w-full text-xs">
        {isPending ? "Uploading…" : "Upload Combined Report"}
      </button>
    </form>
  );
}

export function SatReportReplaceForm({ oldReportId }: { oldReportId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [show, setShow] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    formData.set("oldReportId", oldReportId);
    startTransition(async () => {
      const res = await replaceSatCombinedReportFile(formData);
      if (!res.ok) {
        setError(res.error ?? "Replacement failed.");
        return;
      }
      formRef.current?.reset();
      setShow(false);
      router.refresh();
    });
  }

  if (!show) {
    return (
      <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setShow(true)}>
        Replace…
      </button>
    );
  }

  return (
    <form ref={formRef} action={handleSubmit} className="p-3 rounded-xl border border-border/80 bg-background/80 space-y-2">
      <input name="shiftCoverage" placeholder="Corrected shift coverage" className="vecta-input text-xs" required />
      <textarea name="reason" rows={2} placeholder="Reason for replacement (required)" className="vecta-input text-xs" required />
      <input name="file" type="file" accept="application/pdf" className="input-base text-xs" required />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={() => setShow(false)} disabled={isPending}>
          Cancel
        </button>
        <button type="submit" disabled={isPending} className="px-3 py-1 rounded font-mono text-xs font-bold text-white bg-warning hover:opacity-90">
          {isPending ? "Replacing…" : "Confirm Replacement"}
        </button>
      </div>
    </form>
  );
}
