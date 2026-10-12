"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  closeInvestigationCase,
  getCaseEvidenceUrl,
  linkFlightToCase,
  linkStaffToCase,
  uploadCaseEvidence,
} from "@/lib/phase8/investigation-extras";

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; error: string | null }>, done?: () => void) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      setIsError(!res.ok);
      setMessage(res.ok ? "Saved." : (res.error ?? "Refused."));
      if (res.ok) {
        done?.();
        router.refresh();
      }
    });
  return { pending, message, isError, run };
}

const Status = ({ message, isError }: { message: string | null; isError: boolean }) =>
  message ? (
    <p className={`font-mono text-[11px] ${isError ? "text-brand" : "text-muted-foreground"}`} role={isError ? "alert" : "status"}>
      {message}
    </p>
  ) : null;

export function LinkFlightForm({ caseId }: { caseId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const { pending, message, isError, run } = useAction();
  return (
    <form
      ref={ref}
      aria-label="Link a flight"
      className="card space-y-2 p-3"
      action={(fd) =>
        run(() => linkFlightToCase(caseId, String(fd.get("flight") || ""), String(fd.get("date") || "") || null, String(fd.get("note") || "")), () => ref.current?.reset())
      }
    >
      <p className="font-mono text-xs font-bold">Link a flight</p>
      <div className="grid grid-cols-2 gap-2">
        <input name="flight" aria-label="Flight number" placeholder="AK703 or D7 123" className="input-base text-xs" required maxLength={12} />
        <input name="date" type="date" aria-label="Flight date" className="input-base text-xs" />
      </div>
      <input name="note" aria-label="Note" placeholder="Why this flight (optional)" className="input-base text-xs" maxLength={300} />
      <button type="submit" disabled={pending} className="btn-secondary min-h-[44px] w-full text-xs">
        {pending ? "Linking…" : "Link flight"}
      </button>
      <Status message={message} isError={isError} />
    </form>
  );
}

export function LinkStaffForm({ caseId }: { caseId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const { pending, message, isError, run } = useAction();
  return (
    <form
      ref={ref}
      aria-label="Link a staff member"
      className="card space-y-2 p-3"
      action={(fd) => run(() => linkStaffToCase(caseId, String(fd.get("staffNo") || ""), String(fd.get("note") || "")), () => ref.current?.reset())}
    >
      <p className="font-mono text-xs font-bold">Link a staff member</p>
      <input name="staffNo" aria-label="Staff number" placeholder="Staff number" className="input-base text-xs" required maxLength={30} />
      <input name="note" aria-label="Note" placeholder="Role in the matter (optional)" className="input-base text-xs" maxLength={300} />
      <button type="submit" disabled={pending} className="btn-secondary min-h-[44px] w-full text-xs">
        {pending ? "Linking…" : "Link staff"}
      </button>
      <Status message={message} isError={isError} />
    </form>
  );
}

export function EvidenceUploadForm({ caseId }: { caseId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const { pending, message, isError, run } = useAction();
  return (
    <form
      ref={ref}
      aria-label="Attach evidence"
      className="card space-y-2 p-3"
      action={(fd) => {
        fd.set("caseId", caseId);
        run(() => uploadCaseEvidence(fd), () => ref.current?.reset());
      }}
    >
      <p className="font-mono text-xs font-bold">Attach evidence (PDF, image, text, MP4, MP3 · max 25 MB)</p>
      <input
        name="file"
        type="file"
        aria-label="Evidence file"
        accept="application/pdf,image/png,image/jpeg,image/webp,text/plain,video/mp4,audio/mpeg"
        className="text-xs"
        required
      />
      <input name="description" aria-label="Description" placeholder="What this shows (optional)" className="input-base text-xs" maxLength={300} />
      <button type="submit" disabled={pending} className="btn-secondary min-h-[44px] w-full text-xs">
        {pending ? "Uploading…" : "Attach"}
      </button>
      <Status message={message} isError={isError} />
    </form>
  );
}

export function EvidenceOpenButton({ evidenceId, fileName }: { evidenceId: string; fileName: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        disabled={pending}
        aria-label={`Open evidence ${fileName}`}
        className="min-h-[44px] font-mono text-xs text-primary"
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await getCaseEvidenceUrl(evidenceId);
            if (!res.ok || !res.data) return setError(res.error ?? "Refused.");
            window.open(res.data.url, "_blank", "noopener,noreferrer");
          })
        }
      >
        {pending ? "Opening…" : "Open (audited)"}
      </button>
      {error ? (
        <span className="ml-2 font-mono text-[11px] text-brand" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function CloseCaseForm({ caseId }: { caseId: string }) {
  const { pending, message, isError, run } = useAction();
  const [reason, setReason] = useState("");
  return (
    <div className="card space-y-2 p-3">
      <p className="font-mono text-xs font-bold">Close case (immutable until reopened)</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Closure reason" placeholder="Closure reason (required)" className="input-base text-xs" maxLength={300} />
      <button type="button" disabled={pending || reason.trim().length < 3} onClick={() => run(() => closeInvestigationCase(caseId, reason))} className="btn-secondary min-h-[44px] w-full text-xs">
        {pending ? "Closing…" : "Close case"}
      </button>
      <Status message={message} isError={isError} />
    </div>
  );
}
