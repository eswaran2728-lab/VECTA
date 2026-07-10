"use client";

import { useActionState, useState } from "react";
import { reportIncident, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { INCIDENT_TYPE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";

const initialState: ActionState = { error: null };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function IncidentForm({ transactionId }: { transactionId: string }) {
  const [state, formAction, pending] = useActionState(reportIncident, initialState);
  const [type, setType] = useState<string>("");
  const [photo, setPhoto] = useState<string>("");
  const [photoError, setPhotoError] = useState<string | null>(null);

  const handlePhoto = (file: File | undefined) => {
    setPhotoError(null);
    setPhoto("");
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("Photo must be under 5MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };

  return (
    <Card className="border-red-300 dark:border-red-900">
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="transaction_id" value={transactionId} />
          <input type="hidden" name="incident_type" value={type} />
          <input type="hidden" name="photo" value={photo} />

          <div className="space-y-2">
            <Label>Incident Type</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Object.entries(INCIDENT_TYPE_LABELS).map(([value, label]) => (
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
            <Label htmlFor="photo-input">Photo evidence (optional)</Label>
            <Input
              id="photo-input"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => handlePhoto(e.target.files?.[0])}
              className="h-auto py-2"
            />
            {photoError ? <p className="text-sm text-red-600">{photoError}</p> : null}
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt="Selected evidence" className="max-h-48 rounded border" />
            ) : null}
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
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
