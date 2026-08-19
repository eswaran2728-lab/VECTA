"use client";

import { useActionState } from "react";
import { UserCheck } from "lucide-react";
import {
  approveStaff,
  rejectStaff,
  type ApprovalState,
} from "@/lib/icms/actions/registration";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { ROLE_LABELS } from "@/lib/icms/constants";
import type { Role } from "@/lib/icms/database.types";

const initialState: ApprovalState = { error: null };

interface PendingUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
}

export function PendingApprovals({ pending }: { pending: PendingUser[] }) {
  if (pending.length === 0) return null;

  return (
    <Card className="border-amber-400 dark:border-amber-700">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Pending Approvals ({pending.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.map((user) => (
          <PendingRow key={user.id} user={user} />
        ))}
      </CardContent>
    </Card>
  );
}

function PendingRow({ user }: { user: PendingUser }) {
  const [approveState, approveAction, approvePending] = useActionState(approveStaff, initialState);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectStaff, initialState);
  const busy = approvePending || rejectPending;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">{user.name}</p>
        <p className="text-xs text-muted-foreground">
          {user.email} · Requested {ROLE_LABELS[user.role]} · {user.created_at}
        </p>
        {approveState.error ? <p className="text-xs text-red-600">{approveState.error}</p> : null}
        {rejectState.error ? <p className="text-xs text-red-600">{rejectState.error}</p> : null}
      </div>
      <div className="flex gap-2">
        <form action={approveAction}>
          <input type="hidden" name="user_id" value={user.id} />
          <Button type="submit" size="sm" disabled={busy}>
            {approvePending ? "Approving…" : "Approve"}
          </Button>
        </form>
        <form action={rejectAction}>
          <input type="hidden" name="user_id" value={user.id} />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            {rejectPending ? "Rejecting…" : "Reject"}
          </Button>
        </form>
      </div>
    </div>
  );
}
