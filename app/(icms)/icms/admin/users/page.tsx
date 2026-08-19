import type { Metadata } from "next";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/icms/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/icms/ui/table";
import { Badge } from "@/components/icms/ui/badge";
import { ROLE_LABELS } from "@/lib/icms/constants";
import { formatDate, formatDateTime } from "@/lib/icms/utils";
import { CreateUserForm, RoleSelect } from "./user-forms";
import { PendingApprovals } from "./pending-approvals";
import type { UserProfile } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "User Management" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const supervisor = await requireRole(["supervisor"]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("users")
    .select("*")
    .order("created_at", { ascending: false });

  const allUsers = (data ?? []) as UserProfile[];
  const pending = allUsers.filter((u) => u.status === "pending");
  const users = allUsers.filter((u) => u.status !== "pending");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
        <p className="text-sm text-muted-foreground">
          Create staff accounts, approve registrations, and assign checkpoint roles.
        </p>
      </div>

      <PendingApprovals
        pending={pending.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          created_at: formatDateTime(u.created_at),
        }))}
      />

      <CreateUserForm />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Staff ID</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell className="font-mono">{user.staff_id}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  {user.id === supervisor.id ? (
                    <Badge className="bg-primary/15 text-primary">
                      {ROLE_LABELS[user.role]} (you)
                    </Badge>
                  ) : (
                    <RoleSelect userId={user.id} currentRole={user.role} />
                  )}
                </TableCell>
                <TableCell>
                  {user.status === "rejected" ? (
                    <Badge className="border bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">
                      Rejected
                    </Badge>
                  ) : (
                    <Badge className="border bg-muted text-muted-foreground">Active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(user.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
