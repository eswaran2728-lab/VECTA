"use client";

import { useState } from "react";
import type { FieldValues, UseFormSetValue } from "react-hook-form";
import type { Sec016ParsedFields } from "@/lib/avsec/smart-input/sec016Parser";

export function SmartInputSec016<T extends FieldValues>({
  setValue,
  onParsed,
}: {
  setValue: UseFormSetValue<T>;
  /** Called with the set of field names that were auto-filled, so the parent can
   * pass `autoFilled` down to the matching inputs. */
  onParsed: (filledFields: Set<string>) => void;
}) {
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleParse = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/avsec/reports/sec016/smart-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("Parse request failed");

      const data = (await res.json()) as {
        values: Sec016ParsedFields;
        filledFields: string[];
        totalFields: number;
      };

      for (const field of data.filledFields) {
        const value = data.values[field as keyof Sec016ParsedFields];
        if (value !== undefined) {
          setValue(field as never, value as never, { shouldDirty: true, shouldValidate: true });
        }
      }

      onParsed(new Set(data.filledFields));
      setSummary(
        `Filled ${data.filledFields.length} of ${data.totalFields} recognized fields — please complete the rest.`,
      );
    } catch {
      setErrorMsg("Couldn't parse that message — please fill the form in manually.");
    } finally {
      setParsing(false);
    }
  };

  return (
    <section className="card-inset p-4 sm:p-5 space-y-3">
      <div>
        <h2 className="section-title">Smart Input</h2>
        <p className="field-hint">
          Paste the WhatsApp aircraft report message below and tap Parse &amp; Fill —
          recognized fields will be filled in automatically. Anything it can&apos;t confidently
          read stays blank for you to complete.
        </p>
      </div>
      <textarea
        className="input-base font-mono text-sm"
        rows={8}
        placeholder="Paste WhatsApp message here…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          onClick={handleParse}
          disabled={parsing || !text.trim()}
        >
          {parsing ? "Parsing…" : "Parse & Fill"}
        </button>
        {summary && (
          <p className="text-sm font-medium" style={{ color: "var(--green)" }}>
            {summary}
          </p>
        )}
        {errorMsg && <p className="field-error">{errorMsg}</p>}
      </div>
    </section>
  );
}
