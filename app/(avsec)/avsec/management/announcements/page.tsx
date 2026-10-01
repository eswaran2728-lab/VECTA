import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { getManagementAnnouncements } from "@/lib/avsec/announcements/queries";
import { ManagementAnnouncementsView } from "@/components/avsec/announcements/ManagementAnnouncementsView";
import { createClient } from "@/lib/supabase/server";

export default async function ManagementAnnouncementsPage() {
  const profile = await requireRole(MANAGEMENT_ROLES);
  const announcements = await getManagementAnnouncements();
  const supabase = await createClient();

  // Query caller active role assignments to identify authorized publishing scope
  const { data: assignments } = await supabase
    .from("user_role_assignments")
    .select("role_definitions(code), aoc_id, aocs(code, is_active), starts_at, ends_at, revoked_at")
    .eq("profile_id", profile.id)
    .is("revoked_at", null)
    .lte("starts_at", new Date().toISOString());

  type AssignmentItem = {
    ends_at: string | null;
    role_definitions: { code: string } | null;
    aocs: { code: string } | null;
  };

  const now = new Date();
  const rawList = (assignments || []) as unknown as AssignmentItem[];
  const activeAssignments = rawList.filter((a) => {
    return !a.ends_at || new Date(a.ends_at) > now;
  });

  const isGhod = activeAssignments.some((a) => a.role_definitions?.code === "ghod");
  const isMalaysiaPublisher = activeAssignments.some((a) => {
    const code = a.role_definitions?.code || "";
    const aocCode = a.aocs?.code;
    return ["maa_boss", "maa_admin", "aax_boss", "aax_admin"].includes(code) && aocCode === "MY";
  });

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Management Announcements</h1>
          <p className="text-xs text-muted-foreground">
            Target Global or Malaysia AOC operational directives with mandatory read receipts.
          </p>
        </div>

        <ManagementAnnouncementsView
          initialAnnouncements={announcements}
          isGhod={isGhod}
          isMalaysiaPublisher={isMalaysiaPublisher}
        />
      </div>
    </main>
  );
}
