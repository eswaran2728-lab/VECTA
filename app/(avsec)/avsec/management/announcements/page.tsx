import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { getManagementAnnouncements } from "@/lib/avsec/announcements/queries";
import { ManagementAnnouncementsView } from "@/components/avsec/announcements/ManagementAnnouncementsView";

export default async function ManagementAnnouncementsPage() {
  await requireRole(MANAGEMENT_ROLES);
  const announcements = await getManagementAnnouncements();

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Management Announcements</h1>
          <p className="text-xs text-muted-foreground">
            Target operational directives to branches, stations, or teams with mandatory read receipts.
          </p>
        </div>

        <ManagementAnnouncementsView initialAnnouncements={announcements} />
      </div>
    </main>
  );
}
