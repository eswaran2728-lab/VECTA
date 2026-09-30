"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  openInvestigationCase,
  addInvestigationCaseNote,
  assignInvestigationCase,
  resolveInvestigationCase,
  reopenInvestigationCase,
  linkReportToCase,
  searchReportsForInvestigation,
  type InvestigationSearchResult,
} from "@/lib/phase8/investigation";

export function OpenCaseForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await openInvestigationCase({
        title: String(formData.get("title") || ""),
        classification: String(formData.get("classification") || "") || undefined,
        description: String(formData.get("description") || "") || undefined,
        priority: String(formData.get("priority") || "normal"),
      });
      if (!res.ok || !res.data) {
        setError(res.error ?? "Failed to open case.");
        return;
      }
      formRef.current?.reset();
      router.push(`/avsec/investigation/cases/${res.data.id}`);
    });
  }

  return (
    <form ref={formRef} action={handleSubmit} className="card p-4 space-y-2.5 border-border/80 bg-surface/80">
      <div className="font-mono text-xs font-bold text-foreground">Open New Case</div>
      <input name="title" placeholder="Case title" className="input-base text-xs" required />
      <div className="grid grid-cols-2 gap-2">
        <input name="classification" placeholder="Classification (optional)" className="input-base text-xs" />
        <select name="priority" className="input-base text-xs" defaultValue="normal">
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <textarea name="description" rows={2} placeholder="Description (optional)" className="vecta-input text-xs" />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="submit" disabled={isPending} className="btn-primary w-full text-xs">
        {isPending ? "Opening…" : "Open Case"}
      </button>
    </form>
  );
}

export function AddNoteForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await addInvestigationCaseNote(caseId, String(formData.get("note") || ""));
      if (!res.ok) {
        setError(res.error ?? "Failed to add note.");
        return;
      }
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={handleSubmit} className="card p-3 space-y-2 border-border/80 bg-surface/80">
      <textarea name="note" rows={2} placeholder="Add a note or action…" className="vecta-input text-xs" required />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="submit" disabled={isPending} className="btn-secondary w-full text-xs">
        {isPending ? "Adding…" : "Add Note"}
      </button>
    </form>
  );
}

export function AssignCaseForm({ caseId, staff }: { caseId: string; staff: { profile_id: string; name: string; role_code: string }[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");

  return (
    <div className="card p-3 space-y-2 border-border/80 bg-surface/80">
      <div className="font-mono text-xs font-bold text-foreground">Assign Case</div>
      <select className="input-base text-xs" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">Select investigator…</option>
        {staff.map((s) => (
          <option key={s.profile_id} value={s.profile_id}>
            {s.name} ({s.role_code})
          </option>
        ))}
      </select>
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button
        type="button"
        disabled={isPending || !assignee}
        className="btn-secondary w-full text-xs"
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await assignInvestigationCase(caseId, assignee);
            if (!res.ok) {
              setError(res.error ?? "Failed to assign.");
              return;
            }
            router.refresh();
          })
        }
      >
        {isPending ? "Assigning…" : "Assign"}
      </button>
    </div>
  );
}

export function ResolveCaseForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await resolveInvestigationCase(caseId, String(formData.get("resolution") || ""));
      if (!res.ok) {
        setError(res.error ?? "Failed to resolve.");
        return;
      }
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={handleSubmit} className="card p-3 space-y-2 border-border/80 bg-surface/80">
      <div className="font-mono text-xs font-bold text-foreground">Resolve Case</div>
      <textarea name="resolution" rows={2} placeholder="Resolution (required)…" className="vecta-input text-xs" required />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="submit" disabled={isPending} className="px-3 py-1 rounded font-mono text-xs font-bold text-white bg-success hover:opacity-90 w-full">
        {isPending ? "Resolving…" : "Resolve Case"}
      </button>
    </form>
  );
}

export function ReopenCaseForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await reopenInvestigationCase(caseId, String(formData.get("reason") || ""));
      if (!res.ok) {
        setError(res.error ?? "Failed to reopen.");
        return;
      }
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <form ref={formRef} action={handleSubmit} className="card p-3 space-y-2 border-warning/50 bg-warning/10">
      <div className="font-mono text-xs font-bold text-foreground">Reopen Case (Investigation SSO / Main Enforcement only)</div>
      <textarea name="reason" rows={2} placeholder="Reason for reopening (required)…" className="vecta-input text-xs" required />
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="submit" disabled={isPending} className="px-3 py-1 rounded font-mono text-xs font-bold text-white bg-warning hover:opacity-90 w-full">
        {isPending ? "Reopening…" : "Reopen Case"}
      </button>
    </form>
  );
}

export function LinkReportSearch({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSearching, startSearch] = useTransition();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [results, setResults] = useState<InvestigationSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  function handleSearch() {
    setError(null);
    if (!fromDate || !toDate) {
      setError("Both dates are required.");
      return;
    }
    startSearch(async () => {
      const res = await searchReportsForInvestigation(fromDate, toDate);
      if (!res.ok || !res.data) {
        setError(res.error ?? "Search failed.");
        setResults([]);
        return;
      }
      setResults(res.data);
    });
  }

  function handleLink(reportId: string) {
    setLinkError(null);
    startTransition(async () => {
      const res = await linkReportToCase(caseId, reportId);
      if (!res.ok) {
        setLinkError(res.error ?? "Failed to link.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="card p-3 space-y-2.5 border-border/80 bg-surface/80">
      <div className="font-mono text-xs font-bold text-foreground">Link a Report (authorized search only)</div>
      <div className="grid grid-cols-2 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="input-base text-xs" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input-base text-xs" />
      </div>
      {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
      <button type="button" disabled={isSearching} className="btn-secondary w-full text-xs" onClick={handleSearch}>
        {isSearching ? "Searching…" : "Search"}
      </button>
      {linkError && <p className="font-mono text-[11px] text-brand">{linkError}</p>}
      {results.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          {isSearching ? "" : "No results yet, or nothing authorized was found for this range."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {results.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 p-2 rounded border border-border/60">
              <div className="min-w-0">
                <p className="font-mono text-xs font-bold">{r.reportType.toUpperCase()}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {r.staffName ?? "—"} · {r.station ?? "—"} · {r.secondaryIdentifier ?? ""}
                </p>
              </div>
              <button type="button" disabled={isPending} className="btn-secondary px-2 py-1 text-[11px] shrink-0" onClick={() => handleLink(r.id)}>
                Link
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
