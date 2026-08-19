"use client";

import { useActionState } from "react";
import {
  createUser,
  updateUserRole,
  type UserActionState,
} from "@/lib/icms/actions/users";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { Input } from "@/components/icms/ui/input";
import { Label } from "@/components/icms/ui/label";
import { Select } from "@/components/icms/ui/select";
import { ROLE_LABELS, CREATABLE_ROLES } from "@/lib/icms/constants";
import type { Role } from "@/lib/icms/database.types";

const initialState: UserActionState = { error: null, success: null };

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUser, initialState);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create Account</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="new-name">Full Name</Label>
            <Input id="new-name" name="name" required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-staff-id">Staff ID</Label>
            <Input id="new-staff-id" name="staff_id" required className="font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-email">Email</Label>
            <Input id="new-email" name="email" type="email" required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-role">Role</Label>
            <Select id="new-role" name="role" required defaultValue="">
              <option value="" disabled>
                Select role…
              </option>
              {CREATABLE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-password">Temporary Password</Label>
            <Input
              id="new-password"
              name="password"
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Creating…" : "Create account"}
            </Button>
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-red-600 sm:col-span-2 lg:col-span-3">
              {state.error}
            </p>
          ) : null}
          {state.success ? (
            <p className="text-sm text-emerald-600 sm:col-span-2 lg:col-span-3">
              {state.success}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

export function RoleSelect({ userId, currentRole }: { userId: string; currentRole: Role }) {
  const [state, formAction, pending] = useActionState(updateUserRole, initialState);

  // Obsolete roles (warehouse_pic/receiver/vendor) are no longer
  // selectable, but a handful of existing (now-disabled) accounts still
  // carry one — keep the current value in the option list purely for
  // display so this control doesn't silently show the wrong role.
  const options: Role[] = CREATABLE_ROLES.includes(currentRole)
    ? CREATABLE_ROLES
    : [currentRole, ...CREATABLE_ROLES];

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="user_id" value={userId} />
      <Select
        name="role"
        defaultValue={currentRole}
        className="h-9 w-auto min-w-40 text-sm"
        disabled={pending}
      >
        {options.map((value) => (
          <option key={value} value={value}>
            {ROLE_LABELS[value]}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "…" : "Save"}
      </Button>
      {state.error ? <span className="text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}
