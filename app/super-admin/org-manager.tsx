"use client";

import { useState } from "react";
import { createOrganization, updateOrganizationStatus, type OrganizationRow } from "@/lib/super-admin/actions";
import { Building2, Plus, Shield, AlertCircle, Loader2 } from "lucide-react";

export function OrgManager({
  initialOrgs,
}: {
  initialOrgs: OrganizationRow[];
  userName?: string;
}) {
  const [orgs, setOrgs] = useState<OrganizationRow[]>(initialOrgs);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append("name", name.trim());
    formData.append("code", code.trim());

    const res = await createOrganization(formData);
    if (res.error) {
      setError(res.error);
      setLoading(false);
    } else if (res.organization) {
      setOrgs([res.organization, ...orgs]);
      setName("");
      setCode("");
      setIsCreating(false);
      setLoading(false);
    }
  };

  const handleStatusChange = async (orgId: string, status: "active" | "inactive" | "suspended") => {
    const res = await updateOrganizationStatus(orgId, status);
    if (res.success) {
      setOrgs(
        orgs.map((o) => (o.id === orgId ? { ...o, status } : o))
      );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner */}
      <div className="vecta-panel flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">
              Platform Super Admin
            </h1>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Multi-tenant Organization &amp; Environment Management
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsCreating(!isCreating)}
          className="vecta-btn-primary flex items-center gap-2 cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>{isCreating ? "Cancel" : "Add Organization"}</span>
        </button>
      </div>

      {/* Creation Form */}
      {isCreating && (
        <form
          onSubmit={handleCreate}
          className="vecta-panel space-y-4 border-primary/40 px-6 py-5 transition-all"
        >
          <h2 className="font-display text-base font-bold tracking-[0.02em] text-foreground flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            Create New Tenant / Organization
          </h2>
          <p className="text-xs text-muted-foreground">
            Each tenant gets an isolated sandbox containing its own users, roles, teams, and security reports.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="org-name" className="vecta-label">
                Organization Name *
              </label>
              <input
                id="org-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. AirAsia Aviation Group"
                required
                className="vecta-input"
              />
            </div>
            <div>
              <label htmlFor="org-code" className="vecta-label">
                Organization Code (Optional)
              </label>
              <input
                id="org-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. AIRASIA"
                className="vecta-input uppercase"
              />
            </div>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-xs text-brand font-medium">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="rounded-lg border border-border px-4 py-2 font-mono text-xs text-muted-foreground hover:bg-secondary cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="vecta-btn-primary flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>Create Tenant</span>
            </button>
          </div>
        </form>
      )}

      {/* Organizations List */}
      <div className="vecta-panel px-6 py-5">
        <div className="mb-4 flex items-center justify-between border-b border-border/60 pb-3">
          <p className="vecta-eyebrow">Registered Organizations ({orgs.length})</p>
          <span className="font-mono text-[11px] text-muted-foreground">
            Scoped Multi-Tenant Isolation
          </span>
        </div>

        {orgs.length === 0 ? (
          <p className="text-center py-8 text-sm text-muted-foreground">
            No organizations provisioned yet.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {orgs.map((org) => {
              const isActive = org.status === "active";
              const isSuspended = org.status === "suspended";

              return (
                <div
                  key={org.id}
                  className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-2 last:pb-2"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface border border-border">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-foreground">{org.name}</h3>
                        {org.code && (
                          <span className="vecta-chip font-mono text-[10px]">
                            {org.code}
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                            isActive
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : isSuspended
                              ? "bg-brand/10 text-brand border border-brand/20"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isActive ? "bg-emerald-400" : isSuspended ? "bg-brand" : "bg-muted-foreground"
                            }`}
                          />
                          {org.status}
                        </span>
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground mt-0.5">
                        Tenant ID: {org.id} · Created{" "}
                        {new Date(org.created_at).toLocaleDateString("en-GB")}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(org.id, "suspended")}
                        className="rounded-lg border border-brand/40 bg-brand/5 px-3 py-1.5 font-mono text-[11px] font-semibold text-brand hover:bg-brand/10 cursor-pointer transition-colors"
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(org.id, "active")}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 font-mono text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/10 cursor-pointer transition-colors"
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
