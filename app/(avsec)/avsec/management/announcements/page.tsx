import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { getManagementAnnouncements, getVisibleAnnouncements } from "@/lib/avsec/announcements/queries";
import { ManagementAnnouncementsView } from "@/components/avsec/announcements/ManagementAnnouncementsView";
import { announcementCapabilities } from "@/lib/avsec/announcements/capabilities";

/**
 * Announcement management. The page guard reads the caller's canonical role codes (never legacy profiles.role):
 *  - GHOD manages GLOBAL announcements;
 *  - MAA/AAX Boss and Admin manage MALAYSIA AOC announcements only (they cannot reach the Global channel);
 *  - AirAsia Management is READ-ONLY (it sees visible announcements, with no authoring or acknowledgement-report control);
 *  - every other role is sent back to its dashboard.
 * This is a convenience layer: draft / schedule / publish / edit / pin / priority / archive / attachment and the (audited)
 * acknowledgement report are each re-authorized inside the *_announcement_secure RPCs for the caller's scope.
 */
export default async function ManagementAnnouncementsPage() {
  const profile = await requireProfile();
  const caps = announcementCapabilities((profile.canonical as CanonicalAccess).roleCodes);

  if (caps.mode === "none") redirect("/avsec/my-dashboard");

  if (caps.mode === "read_only") {
    const visible = await getVisibleAnnouncements();
    return (
      <main className="min-h-screen pb-32">
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
          <div>
            <h1 className="font-display text-xl font-bold">Announcements</h1>
            <p className="text-xs text-muted-foreground">Read-only view. AirAsia Management does not author or manage announcements.</p>
          </div>
          {visible.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground" role="status">
              No announcements are currently visible to you.
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((a) => (
                <li key={a.id} className="card space-y-1 p-4">
                  <p className="text-sm font-semibold">{a.title}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {a.scope === "global" ? "Global" : "Malaysia AOC"} · {a.priority}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    );
  }

  const announcements = await getManagementAnnouncements();
  return (
    <main className="min-h-screen pb-32">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <div>
          <h1 className="font-display text-xl font-bold">{caps.canManageGlobal ? "Global Announcements" : "Malaysia AOC Announcements"}</h1>
          <p className="text-xs text-muted-foreground">
            {caps.canManageGlobal
              ? "Global directives with mandatory read receipts."
              : "Malaysia AOC operational directives (MAA and AAX staff) with mandatory read receipts."}
          </p>
        </div>
        <ManagementAnnouncementsView initialAnnouncements={announcements} isGhod={caps.canManageGlobal} isMalaysiaPublisher={caps.canManageMalaysia} />
      </div>
    </main>
  );
}
