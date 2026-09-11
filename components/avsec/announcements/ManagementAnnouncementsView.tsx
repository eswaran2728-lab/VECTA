"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { createAnnouncement } from "@/lib/avsec/announcements/actions";
import { STATIONS, TEAM_EXAMPLES } from "@/lib/avsec/reference-data";
import type { ManagementAnnouncementView } from "@/lib/avsec/types";
import { Megaphone, Plus, X, Loader2, Send, Users, CheckCircle2, Clock } from "lucide-react";

export function ManagementAnnouncementsView({
  initialAnnouncements,
}: {
  initialAnnouncements: ManagementAnnouncementView[];
}) {
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);

  // Form states
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [branch, setBranch] = useState<string>("ALL");
  const [station, setStation] = useState<string>("ALL");
  const [team, setTeam] = useState<string>("ALL");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;

    setIsSubmitting(true);
    const res = await createAnnouncement({
      title,
      body,
      branch: branch === "ALL" ? null : (branch as never),
      station: station === "ALL" ? null : station,
      team: team === "ALL" ? null : team,
    });

    if (res.ok && res.announcementId) {
      const newAnn: ManagementAnnouncementView = {
        id: res.announcementId,
        org_id: null,
        created_by: "",
        title,
        body,
        created_at: new Date().toISOString(),
        targets: [
          {
            id: "temp",
            announcement_id: res.announcementId,
            branch: branch === "ALL" ? null : (branch as never),
            station: station === "ALL" ? null : station,
            team: team === "ALL" ? null : team,
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
      setIsCreating(false);
    } else {
      alert(res.error || "Failed to create announcement");
    }
    setIsSubmitting(false);
  };

  const selectedAudit = announcements.find((a) => a.id === selectedAuditId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Broadcast Announcements</h2>
          <p className="text-xs text-muted-foreground">
            Target operational directives to branches, stations, or teams with mandatory read receipts.
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
        <div className="card p-5 border-border/80 bg-surface/90 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-primary" />
              Create Management Announcement
            </h3>
            <button
              onClick={() => setIsCreating(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="field-label">Announcement Title</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mandatory Security Protocol Update - Gate Frisking"
                className="input-base w-full text-sm"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="field-label">Target Branch</label>
                <select
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="input-base w-full text-xs"
                >
                  <option value="ALL">All Branches (Global)</option>
                  <option value="operation_avsec">Operation AVSEC</option>
                  <option value="ifc_avsec">IFC AVSEC</option>
                  <option value="hub_avsec">Hub AVSEC</option>
                </select>
              </div>

              <div>
                <label className="field-label">Target Station</label>
                <select
                  value={station}
                  onChange={(e) => setStation(e.target.value)}
                  className="input-base w-full text-xs"
                >
                  <option value="ALL">All Stations</option>
                  {STATIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">Target Team</label>
                <select
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  className="input-base w-full text-xs"
                >
                  <option value="ALL">All Teams</option>
                  {TEAM_EXAMPLES.map((t) => (
                    <option key={t} value={t}>
                      Team {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="field-label">Announcement Content</label>
              <textarea
                required
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the announcement directive in full. Targeted staff will see this prominently on their dashboard and must acknowledge receipt."
                className="input-base w-full text-sm leading-relaxed"
              />
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
                disabled={isSubmitting || !title.trim() || !body.trim()}
                className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50"
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
            const target = a.targets[0] || {};
            const pct =
              a.total_target_users > 0
                ? Math.round((a.acknowledged_count / a.total_target_users) * 100)
                : 0;

            const targetSummary = [
              target.branch ? target.branch.replace("_", " ").toUpperCase() : "ALL BRANCHES",
              target.station ? target.station : "ALL STATIONS",
              target.team ? `TEAM ${target.team}` : "ALL TEAMS",
            ].join(" · ");

            return (
              <div
                key={a.id}
                className="card p-4 border-border/80 bg-surface/80 space-y-3 transition-all"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-primary/10 text-primary border border-primary/20">
                        {targetSummary}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {formatDateTimeMY(a.created_at)}
                      </span>
                    </div>

                    <h3 className="font-display font-bold text-base text-foreground">
                      {a.title}
                    </h3>

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

                    <button
                      type="button"
                      onClick={() =>
                        setSelectedAuditId(selectedAuditId === a.id ? null : a.id)
                      }
                      className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                    >
                      <Users className="h-3.5 w-3.5" />
                      <span>Audit Staff ({a.pending_users.length} Pending)</span>
                    </button>
                  </div>
                </div>

                {/* Audit Drawer / Table */}
                {selectedAuditId === a.id && selectedAudit && (
                  <div className="pt-3 border-t border-border/60 space-y-3">
                    <h4 className="text-xs font-bold font-mono uppercase text-foreground flex items-center justify-between">
                      <span>Target Audience Roster Tracking</span>
                      <span className="text-muted-foreground font-normal">
                        {selectedAudit.acknowledged_count} Acknowledged · {selectedAudit.pending_users.length} Pending
                      </span>
                    </h4>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      {/* Acknowledged List */}
                      <div className="space-y-1.5 p-3 rounded-lg bg-surface border border-emerald-500/20 max-h-60 overflow-y-auto">
                        <div className="font-bold text-emerald-400 flex items-center gap-1 mb-1">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Acknowledged ({selectedAudit.acknowledgements.length})</span>
                        </div>
                        {selectedAudit.acknowledgements.length === 0 ? (
                          <p className="text-muted-foreground text-[11px]">No acknowledgements yet.</p>
                        ) : (
                          selectedAudit.acknowledgements.map((u) => (
                            <div key={u.user_id} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                              <div>
                                <p className="font-semibold">{u.name}</p>
                                <p className="text-[10px] text-muted-foreground font-mono">
                                  {u.role} {u.station ? `· ${u.station}` : ""} {u.team ? `· ${u.team}` : ""}
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
                          <span>Pending Read Receipt ({selectedAudit.pending_users.length})</span>
                        </div>
                        {selectedAudit.pending_users.length === 0 ? (
                          <p className="text-emerald-400 text-[11px]">All targeted staff have acknowledged! ✓</p>
                        ) : (
                          selectedAudit.pending_users.map((u) => (
                            <div key={u.user_id} className="py-1 border-b border-border/40 last:border-0">
                              <p className="font-semibold">{u.name}</p>
                              <p className="text-[10px] text-muted-foreground font-mono">
                                {u.role} {u.station ? `· ${u.station}` : ""} {u.team ? `· ${u.team}` : ""}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
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
