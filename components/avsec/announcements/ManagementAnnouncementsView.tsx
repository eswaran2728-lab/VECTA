"use client";

import { useState, useRef } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import {
  createAnnouncementSecure,
  archiveAnnouncementSecure,
  publishAnnouncementSecure,
  fetchAnnouncementReport,
} from "@/lib/avsec/announcements/actions";
import { compressImage } from "@/lib/avsec/image-compression";
import type {
  ManagementAnnouncementView,
  AnnouncementScope,
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementStatus,
  AnnouncementAcknowledgementReport,
} from "@/lib/avsec/types";
import {
  Megaphone,
  Plus,
  X,
  Loader2,
  Send,
  Users,
  CheckCircle2,
  Clock,
  Image as ImageIcon,
  Zap,
  Globe,
  Flag,
  Pin,
  Archive,
  Calendar,
  ShieldAlert,
} from "lucide-react";

export function ManagementAnnouncementsView({
  initialAnnouncements,
}: {
  initialAnnouncements: ManagementAnnouncementView[];
}) {
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [activeReport, setActiveReport] = useState<AnnouncementAcknowledgementReport | null>(null);
  const [isLoadingReport, setIsLoadingReport] = useState(false);

  // Form states
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<AnnouncementScope>("aoc");
  const [category, setCategory] = useState<AnnouncementCategory>("operational");
  const [priority, setPriority] = useState<AnnouncementPriority>("normal");
  const [status, setStatus] = useState<AnnouncementStatus>("published");
  const [scheduledAt, setScheduledAt] = useState("");
  const [requiresAck, setRequiresAck] = useState(true);
  const [isPinned, setIsPinned] = useState(false);
  const [station, setStation] = useState<string>("ALL");
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [isCompressingPhoto, setIsCompressingPhoto] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("Please select a valid image file.");
      return;
    }

    setIsCompressingPhoto(true);
    try {
      const compressedBlob = await compressImage(file, {
        maxDimension: 1600,
        quality: 0.8,
        format: "image/webp",
      });

      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoDataUrl(reader.result as string);
        setIsCompressingPhoto(false);
      };
      reader.readAsDataURL(compressedBlob);
    } catch (err) {
      console.error("Photo compression error:", err);
      alert("Failed to process image. Please try another image.");
      setIsCompressingPhoto(false);
    }
  };

  const handleRemovePhoto = () => {
    setPhotoDataUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;

    setIsSubmitting(true);
    const res = await createAnnouncementSecure({
      title: title.trim(),
      body: body.trim(),
      scope,
      category,
      priority,
      status,
      publishedAt: status === "scheduled" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      requiresAcknowledgement: requiresAck,
      isPinned,
    });

    if (res.ok && res.announcementId) {
      const newAnn: ManagementAnnouncementView = {
        id: res.announcementId,
        org_id: null,
        created_by: "",
        title: title.trim(),
        body: body.trim(),
        photo_url: photoDataUrl,
        is_pop: priority === "urgent",
        created_at: new Date().toISOString(),
        targets: [
          {
            id: "temp",
            announcement_id: res.announcementId,
            branch: null,
            station: station === "ALL" ? null : station,
            team: null,
            created_at: new Date().toISOString(),
          },
        ],
        total_target_users: 0,
        acknowledged_count: 0,
        acknowledgements: [],
        pending_users: [],
      };
      setAnnouncements([newAnn, ...announcements]);
      setTitle("");
      setBody("");
      setScope("aoc");
      setCategory("operational");
      setPriority("normal");
      setStatus("published");
      setScheduledAt("");
      setRequiresAck(true);
      setIsPinned(false);
      setStation("ALL");
      setPhotoDataUrl(null);
      setIsCreating(false);
    } else {
      alert(res.error || "Failed to create announcement. Check role permissions.");
    }
    setIsSubmitting(false);
  };

  const handleAuditClick = async (announcementId: string) => {
    if (selectedAuditId === announcementId) {
      setSelectedAuditId(null);
      setActiveReport(null);
      return;
    }

    setSelectedAuditId(announcementId);
    setIsLoadingReport(true);
    try {
      const report = await fetchAnnouncementReport(announcementId);
      setActiveReport(report);
    } catch (err) {
      console.error("Error fetching report:", err);
    } finally {
      setIsLoadingReport(false);
    }
  };

  const handlePublishNow = async (announcementId: string) => {
    if (!confirm("Publish this announcement now?")) return;
    const res = await publishAnnouncementSecure(announcementId, new Date().toISOString());
    if (res.ok) {
      alert("Announcement published successfully.");
      window.location.reload();
    } else {
      alert(res.error || "Failed to publish announcement");
    }
  };

  const handleArchive = async (announcementId: string) => {
    const reason = prompt("Enter reason for archiving this announcement:", "Replaced by new directive");
    if (!reason) return;
    const res = await archiveAnnouncementSecure(announcementId, reason);
    if (res.ok) {
      alert("Announcement archived.");
      setAnnouncements((prev) => prev.filter((a) => a.id !== announcementId));
    } else {
      alert(res.error || "Failed to archive announcement");
    }
  };

  return (
    <div className="space-y-4">
      {/* Governance Banner */}
      <div className="p-3.5 rounded-xl border border-sky-500/30 bg-sky-500/10 flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-sky-400 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-semibold text-foreground">
            Announcement Publishing Authority &amp; Scope Matrix (Phase 11)
          </p>
          <p className="text-muted-foreground leading-relaxed">
            <strong className="text-sky-300">Global Announcements:</strong> Authorized strictly to <strong>GHOD</strong> with executive global oversight. Generic Admin, Super Admin, and AirAsia Management cannot publish Global notices.
            <br />
            <strong className="text-sky-300">Malaysia AOC Announcements:</strong> Managed by <strong>MAA Boss, MAA Admin, AAX Boss, AAX Admin</strong>, and GHOD.
            AirAsia Management dashboard remains strictly read-only.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Broadcast Directives &amp; Announcements</h2>
          <p className="text-xs text-muted-foreground">
            Target Global or Malaysia AOC operational directives with mandatory read receipts, attachments, and audit reports.
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="btn-primary flex items-center gap-1.5 text-xs"
        >
          <Plus className="h-4 w-4" />
          <span>New Announcement</span>
        </button>
      </div>

      {/* Creation Modal / Form */}
      {isCreating && (
        <div className="card p-5 border-border/80 bg-surface/90 space-y-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-primary" />
              Create Announcement
            </h3>
            <button
              onClick={() => setIsCreating(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreate} className="space-y-3.5">
            <div>
              <label className="field-label">Announcement Title</label>
              <input
                type="text"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mandatory Security Protocol Update - Gate Frisking"
                className="input-base w-full text-sm"
              />
            </div>

            {/* Scope & Category Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="field-label">Scope</label>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as AnnouncementScope)}
                  className="input-base w-full text-xs"
                >
                  <option value="global">Global (AirAsia Network — GHOD Authorized)</option>
                  <option value="aoc">Malaysia AOC (MAA / AAX — Boss/Admin Authorized)</option>
                  <option value="entity">Operating Entity Specific</option>
                  <option value="department">Department Specific</option>
                  <option value="station">Station Specific</option>
                </select>
              </div>

              <div>
                <label className="field-label">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as AnnouncementCategory)}
                  className="input-base w-full text-xs"
                >
                  <option value="operational">Operational</option>
                  <option value="security">Security</option>
                  <option value="safety">Safety</option>
                  <option value="policy">Policy</option>
                  <option value="system">System</option>
                  <option value="general">General</option>
                </select>
              </div>
            </div>

            {/* Priority & Status Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="field-label">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}
                  className="input-base w-full text-xs"
                >
                  <option value="normal">Normal</option>
                  <option value="important">Important</option>
                  <option value="urgent">Urgent (Immediate Highlight)</option>
                </select>
              </div>

              <div>
                <label className="field-label">Publication Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as AnnouncementStatus)}
                  className="input-base w-full text-xs"
                >
                  <option value="published">Publish Immediately</option>
                  <option value="scheduled">Schedule for Future Time</option>
                  <option value="draft">Save as Draft</option>
                </select>
              </div>
            </div>

            {/* Scheduled Date Picker */}
            {status === "scheduled" && (
              <div>
                <label className="field-label flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-primary" />
                  <span>Scheduled Publish Date &amp; Time (Local)</span>
                </label>
                <input
                  type="datetime-local"
                  required
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="input-base w-full text-xs"
                />
              </div>
            )}

            <div>
              <label className="field-label">Announcement Content</label>
              <textarea
                required
                maxLength={20000}
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the announcement directive in full. Eligible staff will see this on their dashboard and must acknowledge receipt."
                className="input-base w-full text-sm leading-relaxed"
              />
            </div>

            {/* Optional Photo Attachment */}
            <div className="space-y-2">
              <label className="field-label">Optional Photo Attachment</label>
              {photoDataUrl ? (
                <div className="relative inline-block border border-border rounded-xl overflow-hidden bg-background max-w-sm">
                  <img
                    src={photoDataUrl}
                    alt="Attachment Preview"
                    className="max-h-48 w-auto object-contain"
                  />
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-background/90 text-destructive hover:bg-destructive hover:text-destructive-foreground shadow transition-colors"
                    title="Remove Photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoSelect}
                    className="hidden"
                    id="announcement-photo-upload"
                  />
                  <label
                    htmlFor="announcement-photo-upload"
                    className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer hover:border-primary/60"
                  >
                    {isCompressingPhoto ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <ImageIcon className="h-4 w-4 text-primary" />
                    )}
                    <span>
                      {isCompressingPhoto ? "Compressing Photo..." : "Attach Photo (Optional)"}
                    </span>
                  </label>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    Auto-compressed (WebP)
                  </span>
                </div>
              )}
            </div>

            {/* Checkboxes: Acknowledgement & Pin */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <label className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/60 cursor-pointer hover:border-primary/50 transition-colors">
                <input
                  type="checkbox"
                  checked={requiresAck}
                  onChange={(e) => setRequiresAck(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <div className="space-y-0.5">
                  <div className="font-bold text-xs text-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Mandatory Acknowledgement</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Requires staff to click &quot;Acknowledge&quot; with read receipt recorded.
                  </p>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/60 cursor-pointer hover:border-primary/50 transition-colors">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={(e) => setIsPinned(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <div className="space-y-0.5">
                  <div className="font-bold text-xs text-foreground flex items-center gap-1.5">
                    <Pin className="h-3.5 w-3.5 text-amber-400" />
                    <span>Pin Announcement</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Pins announcement to the very top of staff dashboard feed.
                  </p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || isCompressingPhoto || !title.trim() || !body.trim()}
                className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span>Broadcast to Staff</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Announcements List */}
      <div className="space-y-3">
        {announcements.length === 0 ? (
          <div className="card p-8 text-center space-y-2 border-dashed">
            <Megaphone className="h-8 w-8 mx-auto text-muted-foreground opacity-40" />
            <p className="text-sm font-semibold">No announcements broadcasted yet</p>
          </div>
        ) : (
          announcements.map((a) => {
            const pct =
              a.total_target_users > 0
                ? Math.round((a.acknowledged_count / a.total_target_users) * 100)
                : 0;

            const isGlobal = a.targets.length === 0 || a.targets[0]?.station === null;

            return (
              <div
                key={a.id}
                className="card p-4 border-border/80 bg-surface/80 space-y-3 transition-all"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {isGlobal ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-purple-500/10 text-purple-400 border border-purple-500/30 flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          <span>GLOBAL (GHOD)</span>
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/30 flex items-center gap-1">
                          <Flag className="h-3 w-3" />
                          <span>MALAYSIA AOC</span>
                        </span>
                      )}

                      {a.is_pop && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          <span>URGENT</span>
                        </span>
                      )}

                      <span className="text-[11px] font-mono text-muted-foreground">
                        {formatDateTimeMY(a.created_at)}
                      </span>
                    </div>

                    <h3 className="font-display font-bold text-base text-foreground">
                      {a.title}
                    </h3>

                    {a.photo_url && (
                      <div className="pt-1">
                        <img
                          src={a.photo_url}
                          alt={a.title}
                          className="max-h-36 w-auto object-cover rounded-lg border border-border"
                        />
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed whitespace-pre-wrap">
                      {a.body}
                    </p>
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-2 shrink-0">
                    <div className="text-right font-mono">
                      <span className="text-sm font-bold text-foreground">
                        {a.acknowledged_count} / {a.total_target_users}
                      </span>
                      <span className="text-xs text-muted-foreground ml-1">
                        ({pct}%)
                      </span>
                      <p className="text-[10px] text-muted-foreground">Acknowledged</p>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePublishNow(a.id)}
                        className="btn-secondary text-[11px] px-2 py-1 flex items-center gap-1 text-primary hover:text-primary-foreground hover:bg-primary"
                        title="Publish immediately"
                      >
                        <Send className="h-3 w-3" />
                        <span>Publish</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAuditClick(a.id)}
                        className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                      >
                        <Users className="h-3.5 w-3.5" />
                        <span>Audit Staff</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleArchive(a.id)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Archive announcement"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Audit Drawer / Table */}
                {selectedAuditId === a.id && (
                  <div className="pt-3 border-t border-border/60 space-y-3">
                    <h4 className="text-xs font-bold font-mono uppercase text-foreground flex items-center justify-between">
                      <span>Target Audience Acknowledgement Report</span>
                      {activeReport && (
                        <span className="text-muted-foreground font-normal">
                          {activeReport.total_acknowledged} Acknowledged · {activeReport.pending_count} Pending ({activeReport.compliance_percentage}% Rate)
                        </span>
                      )}
                    </h4>

                    {isLoadingReport ? (
                      <div className="flex items-center justify-center p-4">
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      </div>
                    ) : activeReport ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        {/* Acknowledged List */}
                        <div className="space-y-1.5 p-3 rounded-lg bg-surface border border-emerald-500/20 max-h-60 overflow-y-auto">
                          <div className="font-bold text-emerald-400 flex items-center gap-1 mb-1">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Acknowledged ({activeReport.acknowledged_staff.length})</span>
                          </div>
                          {activeReport.acknowledged_staff.length === 0 ? (
                            <p className="text-muted-foreground text-[11px]">No acknowledgements yet.</p>
                          ) : (
                            activeReport.acknowledged_staff.map((u) => (
                              <div key={u.profile_id} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                                <div>
                                  <p className="font-semibold">{u.name}</p>
                                  <p className="text-[10px] text-muted-foreground font-mono">
                                    {u.staff_no} {u.department ? `· ${u.department}` : ""} {u.station ? `· ${u.station}` : ""}
                                  </p>
                                </div>
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  {formatDateTimeMY(u.acknowledged_at)}
                                </span>
                              </div>
                            ))
                          )}
                        </div>

                        {/* Pending List */}
                        <div className="space-y-1.5 p-3 rounded-lg bg-surface border border-amber-500/20 max-h-60 overflow-y-auto">
                          <div className="font-bold text-amber-400 flex items-center gap-1 mb-1">
                            <Clock className="h-3.5 w-3.5" />
                            <span>Pending Read Receipt ({activeReport.pending_staff.length})</span>
                          </div>
                          {activeReport.pending_staff.length === 0 ? (
                            <p className="text-emerald-400 text-[11px]">All active staff have acknowledged! ✓</p>
                          ) : (
                            activeReport.pending_staff.map((u) => (
                              <div key={u.profile_id} className="py-1 border-b border-border/40 last:border-0">
                                <p className="font-semibold">{u.name}</p>
                                <p className="text-[10px] text-muted-foreground font-mono">
                                  {u.staff_no} {u.department ? `· ${u.department}` : ""} {u.station ? `· ${u.station}` : ""}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No detailed report available.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
