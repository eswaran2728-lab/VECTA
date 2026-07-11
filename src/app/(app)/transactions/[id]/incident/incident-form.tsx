"use client";

import { useActionState, useState } from "react";
import { reportIncident, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INCIDENT_TYPE_LABELS } from "@/lib/constants";
import { formDataToPayload, queueSubmission } from "@/lib/offline-queue";
import { cn } from "@/lib/utils";

const initialState: ActionState = { error: null };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function IncidentForm({ transactionId }: { transactionId: string }) {
  const [state, formAction, pending] = useActionState(reportIncident, initialState);
  const [type, setType] = useState<string>("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);

  const handleOffline = (e: React.FormEvent<HTMLFormElement>) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      void queueSubmission("incident", formDataToPayload(e.currentTarget)).then(() =>
        setQueuedMsg(
          "Offline — this incident report is saved on the device and will sync (and escalate) automatically when the connection returns."
        )
      );
    }
  };

  const handlePhotos = (files: FileList | null) => {
    setPhotoError(null);
    setPhotos([]);
    if (!files || files.length === 0) return;
    const list = Array.from(files).slice(0, 5);
    if (list.some((f) => f.size > MAX_PHOTO_BYTES)) {
      setPhotoError("Each photo must be under 5MB (max 5 photos).");
      return;
    }
    Promise.all(
      list.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(file);
          })
      )
    )
      .then(setPhotos)
      .catch(() => setPhotoError("Could not read the selected photos."));
  };

  return (
    <Card className="border-red-300 dark:border-red-900">
      <CardContent className="pt-6">
        <form action={formAction} onSubmit={handleOffline} className="space-y-5">
          <input type="hidden" name="transaction_id" value={transactionId} />
          <input type="hidden" name="incident_type" value={type} />
          <input type="hidden" name="photos" value={JSON.stringify(photos)} />

          <div className="space-y-2">
            <Label>Incident Type</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Object.entries(INCIDENT_TYPE_LABELS)
                .filter(([value]) => value !== "TIMEOUT")
                .map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  className={cn(
                    "rounded-lg border p-4 text-left text-base font-medium transition-colors",
                    type === value
                      ? "border-red-500 bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100"
                      : "border-input hover:bg-accent"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">What happened?</Label>
            <Textarea
              id="description"
              name="description"
              rows={4}
              required
              placeholder="Describe the discrepancy, seal condition, identities involved…"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="photo-input">Photo evidence (optional, up to 5)</Label>
            <Input
              id="photo-input"
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => handlePhotos(e.target.files)}
              className="h-auto py-2"
            />
            {photoError ? <p className="text-sm text-red-600">{photoError}</p> : null}
            {photos.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {photos.map((p, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={p} alt={`Evidence ${i + 1}`} className="max-h-32 rounded border" />
                ))}
              </div>
            ) : null}
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          {queuedMsg ? (
            <p className="rounded-md bg-amber-100 p-3 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              {queuedMsg}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="destructive"
            size="xl"
            className="w-full"
            disabled={pending || !type}
          >
            {pending ? "Submitting…" : "Submit Incident & Escalate"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
