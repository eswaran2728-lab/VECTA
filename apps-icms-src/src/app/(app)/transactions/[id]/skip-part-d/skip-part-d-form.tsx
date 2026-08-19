"use client";

import { useActionState } from "react";
import { skipPartD, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initialState: ActionState = { error: null };

export function SkipPartDForm({ transactionId }: { transactionId: string }) {
  const [state, formAction, pending] = useActionState(skipPartD, initialState);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="transaction_id" value={transactionId} />
          <div className="space-y-2">
            <Label htmlFor="reason">Reason Part D is being skipped</Label>
            <Textarea id="reason" name="reason" rows={3} required placeholder="e.g. Receiver unavailable, delivery confirmed by phone with Post 6" />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" size="xl" className="w-full" disabled={pending}>
            {pending ? "Completing…" : "Complete Transaction Without Part D"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
