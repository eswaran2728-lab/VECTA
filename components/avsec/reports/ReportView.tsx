import { SEC029_ITEMS, SECURITY_DISCLAIMER, SEC013_CERTIFICATION_TEXT } from "@/lib/avsec/reference-data";
import { formatDateTimeMY, formatDateMY, formatTimeMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";
import type {
  Sec016Row,
  Sec014Row,
  Sec014PatrolEntry,
  Sec029Row,
  Sec029ItemEntry,
  Sec018Row,
  Sec018PatrolEntry,
  Sec033Row,
  Sec033HoldCheckEntry,
  Sec013Row,
  Sec013ProfilingDutyEntry,
  OffloadRow,
  OffloadItemEntry,
} from "@/lib/avsec/types";

export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-semibold text-foreground break-words">
        {value === "" || value == null ? "—" : value}
      </p>
    </div>
  );
}

export function ViewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-5 space-y-4 border-border/80 bg-surface/80">
      <h2 className="section-title">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

/** Read-only equivalent of the form's EntryCard, for a logged submission. */
function ViewEntryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card-inset p-3.5 space-y-2 rounded-lg border border-border/70 bg-surface/50">
      <p className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-foreground">
        {label}
      </p>
      <div className="text-xs text-muted-foreground leading-relaxed">
        {children}
      </div>
    </div>
  );
}

export function Sec016View({ report }: { report: Sec016Row }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Movement & Staff Details">
        <Field
          label="Flight Type"
          value={
            <span
              className={cn(
                "inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold uppercase",
                report.flight_type === "departure"
                  ? "bg-sky-500/10 text-sky-400 border border-sky-500/20"
                  : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              )}
            >
              {report.flight_type ? report.flight_type.toUpperCase() : "ARRIVAL"}
            </span>
          }
        />
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff No" value={report.staff_no} />
        <Field label="Date" value={formatDateMY(report.duty_date)} />
        <Field label="Duty Hour" value={report.duty_hour} />
        {report.flight_type === "departure" && (
          <>
            <Field
              label="Aircraft Search Completed"
              value={report.aircraft_search_completed ? "✓ Yes (Completed)" : "✗ No (Not Completed)"}
            />
            {report.search_overdue_flag && (
              <Field
                label="Search Warning / Flag"
                value={
                  <span className="text-red-400 font-bold font-mono text-xs">
                    ⚠️ {report.search_remark || "Aircraft Search not completed — aircraft on ground >4h"}
                  </span>
                }
              />
            )}
          </>
        )}
      </ViewSection>

      <ViewSection title="Aircraft Details">
        <Field label="Flight" value={report.flight} />
        <Field label="Origin Arr / Dep" value={report.origin_arr_dep} />
        <Field label="Assisted By" value={report.assisted_by} />
        <Field
          label="Aircraft Type"
          value={report.aircraft_type === "Other" ? `Other (${report.aircraft_type_other})` : report.aircraft_type}
        />
        <Field label="Reg No" value={report.reg_no} />
        <Field label="STA / STD" value={report.sta_std} />
        <Field label="ATA / ATD" value={report.ata_atd} />
        <Field label="Bay No" value={report.bay_no} />
        <Field label="Reason for Delay" value={report.reason_for_delay} />
        <Field label="D/O INFMD" value={report.do_infmd} />
        <Field label="Inbound Baggage" value={report.inbound_baggage} />
        <Field label="Outbound Baggage" value={report.outbound_baggage} />
        <Field label="Inbound Cargo" value={report.inbound_cargo} />
        <Field label="Outbound Cargo" value={report.outbound_cargo} />
        <Field label="Inbound Co-Mail" value={report.inbound_co_mail} />
        <Field label="Outbound Co-Mail" value={report.outbound_co_mail} />
      </ViewSection>

      <ViewSection title="Search & Screening Details">
        <Field label="Checked Items" value={report.checked_items?.join(", ") || "None"} />
        <Field label="Shift Leader" value={report.shift_leader} />
        <Field
          label="Ramp Staff"
          value={[report.ramp_staff_1, report.ramp_staff_2, report.ramp_staff_3, report.ramp_staff_4, report.ramp_staff_5]
            .filter(Boolean)
            .join(", ") || "—"}
        />
        <Field label="Cargo Hold Checked" value={report.cargo_hold_checked} />
        <Field label="Staff Frisked" value={report.staff_frisked} />
        <Field label="Discrepancies" value={report.discrepancies} />
      </ViewSection>

      {report.offload_flight_no && (
        <ViewSection title="Offload Information">
          <Field label="Flight No" value={report.offload_flight_no} />
          <Field label="Destination" value={report.offload_destination} />
          <Field label="Baggage Tag No" value={report.offload_baggage_tag_no} />
          <Field label="Total Baggage" value={report.offload_total_baggage} />
          <Field label="Remark" value={report.offload_remark} />
        </ViewSection>
      )}
    </div>
  );
}

export function Sec014View({ report }: { report: Sec014Row & { patrols?: Sec014PatrolEntry[] } }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Staff & Station Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff ID" value={report.staff_id} />
        <Field label="Date & Time In" value={formatDateTimeMY(report.date_time_in)} />
        <Field label="Date & Time Out" value={formatDateTimeMY(report.date_time_out)} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3 border-border/80 bg-surface/80">
        <h2 className="section-title">Patrolling</h2>
        {(!report.patrols || report.patrols.length === 0) && (
          <p className="text-xs text-muted-foreground">No patrol entries logged.</p>
        )}
        <div className="space-y-2">
          {report.patrols?.map((p) => (
            <ViewEntryCard key={p.entry_no} label={`Entry ${p.entry_no}`}>
              <p className="font-semibold text-foreground">
                {p.location ?? "—"} · {p.time_from ?? "—"}–{p.time_to ?? "—"}
              </p>
              <p className="mt-1 text-muted-foreground">{p.description}</p>
            </ViewEntryCard>
          ))}
        </div>
      </section>

      <ViewSection title="Remark">
        <div className="sm:col-span-2">
          <Field label="Issue(s) / Event(s) / Equipment(s)" value={report.remark} />
        </div>
      </ViewSection>
    </div>
  );
}

export function Sec029View({ report }: { report: Sec029Row & { items?: Sec029ItemEntry[] } }) {
  const itemMap = new Map((report.items ?? []).map((i) => [i.item_code, i]));

  return (
    <div className="space-y-4">
      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Supervising Officer" value={`${report.supervising_officer_name} (${report.supervising_officer_id})`} />
        <Field label="Staff" value={`${report.staff_name} (${report.staff_id})`} />
        <Field label="Assisted By" value={`${report.assisted_by_name} (${report.assisted_by_id})`} />
      </ViewSection>

      <ViewSection title="Aircraft Details">
        <Field label="Aircraft Type" value={report.aircraft_type} />
        <Field label="Flight No" value={report.flight_no} />
        <Field label="Aircraft Registration" value={report.aircraft_registration} />
        <Field label="STD" value={report.std} />
        <Field label="Parking Bay" value={report.parking_bay} />
        <Field label="Time Commence" value={report.time_commence} />
        <Field label="Time Completed" value={report.time_completed} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-2 border-border/80 bg-surface/80">
        <h2 className="section-title mb-2">Checklist Result</h2>
        {SEC029_ITEMS.map((item) => {
          const entry = itemMap.get(item.code);
          if (!entry) return null;
          const flagged = entry.checked === "NO" || entry.remark_type === "other";
          return (
            <div
              key={item.code}
              className="flex items-center justify-between gap-2 py-2 border-b border-border/50 last:border-0"
            >
              <span className="text-xs text-foreground">
                {item.label}
                {entry.remark_type === "other" && entry.remark_text ? ` — ${entry.remark_text}` : ""}
              </span>
              <span
                className={cn(
                  "font-mono text-[10px] font-bold shrink-0 px-2 py-0.5 rounded border",
                  flagged
                    ? "bg-red-500/10 text-red-400 border-red-500/30"
                    : entry.checked === "NA"
                    ? "bg-muted text-muted-foreground border-border"
                    : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                )}
              >
                {entry.checked}
              </span>
            </div>
          );
        })}
      </section>

      <ViewSection title="Final">
        <Field label="Information to PIC" value={report.pic_informed} />
        <Field label="Declaration" value={report.declaration} />
        {report.d_remark && (
          <div className="sm:col-span-2">
            <Field label="Remark / Detection" value={report.d_remark} />
          </div>
        )}
      </ViewSection>
    </div>
  );
}

export function Sec018View({ report }: { report: Sec018Row & { patrols?: Sec018PatrolEntry[] } }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Date & Time" value={formatDateTimeMY(report.date_time)} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3 border-border/80 bg-surface/80">
        <h2 className="section-title">Patrolling Details</h2>
        {(!report.patrols || report.patrols.length === 0) && (
          <p className="text-xs text-muted-foreground">No patrol entries logged.</p>
        )}
        <div className="space-y-2">
          {report.patrols?.map((p) => (
            <ViewEntryCard key={p.entry_no} label={`Entry ${p.entry_no}`}>
              <p className="font-semibold text-foreground">
                {p.time_from ?? "—"}–{p.time_to ?? "—"} · Bay {p.parking_bay ?? "—"} · {p.aircraft_type ?? "—"} ·{" "}
                {p.reg_no ?? "—"}
              </p>
              <p className="mt-1 text-muted-foreground">{p.description}</p>
            </ViewEntryCard>
          ))}
        </div>
      </section>
    </div>
  );
}

export function Sec033View({ report }: { report: Sec033Row & { hold_checks?: Sec033HoldCheckEntry[] } }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground bg-surface p-3 rounded-lg border border-border/60">{SECURITY_DISCLAIMER}</p>

      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff ID" value={report.staff_id} />
        <Field label="Date" value={formatDateMY(report.report_date)} />
        <Field label="Time" value={formatTimeMY(report.report_time)} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3 border-border/80 bg-surface/80">
        <h2 className="section-title">Hold Check Details</h2>
        {(!report.hold_checks || report.hold_checks.length === 0) && (
          <p className="text-xs text-muted-foreground">No hold check entries logged.</p>
        )}
        <div className="space-y-2">
          {report.hold_checks?.map((h) => (
            <ViewEntryCard key={h.entry_no} label={`Hold Check ${h.entry_no}`}>
              <p className="font-semibold text-foreground">
                Bay {h.parking_bay_no} · Reg {h.aircraft_registration_no}
              </p>
              {h.remarks && <p className="mt-1 text-muted-foreground">{h.remarks}</p>}
            </ViewEntryCard>
          ))}
        </div>
      </section>
    </div>
  );
}

export function Sec013View({ report }: { report: Sec013Row & { profiling_duties?: Sec013ProfilingDutyEntry[] } }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground bg-surface p-3 rounded-lg border border-border/60">{SECURITY_DISCLAIMER}</p>

      <ViewSection title="Staff Details">
        <Field label="Hub/Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff ID" value={report.staff_id} />
        <Field label="Date & Time In" value={formatDateTimeMY(report.date_time_in)} />
        <Field label="Date & Time Out" value={formatDateTimeMY(report.date_time_out)} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3 border-border/80 bg-surface/80">
        <h2 className="section-title">Profiling Duty</h2>
        {(!report.profiling_duties || report.profiling_duties.length === 0) && (
          <p className="text-xs text-muted-foreground">No profiling duty entries logged.</p>
        )}
        <div className="space-y-2">
          {report.profiling_duties?.map((d) => (
            <ViewEntryCard key={d.entry_no} label={`Duty ${d.entry_no}`}>
              <p className="font-semibold text-foreground">
                {d.duty_area} · {d.location} · {d.time_from}–{d.time_to} · Sector/Flight {d.sector_flight}
              </p>
              <p className="mt-1 text-muted-foreground">{d.description}</p>
              {d.incident_remark && (
                <p className="mt-1 text-amber-400 font-mono text-xs">
                  {d.incident_remark}
                </p>
              )}
            </ViewEntryCard>
          ))}
        </div>
      </section>

      <section className="card p-4 sm:p-5 space-y-3 border-primary/40 bg-card">
        <h2 className="section-title">Final Remarks &amp; Certification</h2>
        <Field label="Remark" value={report.remark} />
        <Field label="Corrective Action / Follow-up / Recommendation" value={report.corrective_action} />
        <p className="text-xs text-muted-foreground">
          {SEC013_CERTIFICATION_TEXT} — {report.acknowledgement ? "✓ Certified" : "Not certified"}
        </p>
      </section>
    </div>
  );
}

export function OffloadView({ report }: { report: OffloadRow & { items?: OffloadItemEntry[] } }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff ID" value={report.staff_id} />
      </ViewSection>

      <ViewSection title="Flight Details">
        <Field label="Flight No" value={report.flight_no} />
        <Field label="Destination" value={report.destination} />
        <Field label="Aircraft Registration" value={report.aircraft_registration} />
        <Field label="Flight Date" value={formatDateMY(report.flight_date)} />
        <Field label="STD" value={report.std} />
        <Field label="Total Bags" value={report.total_bags} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3 border-border/80 bg-surface/80">
        <h2 className="section-title">Offloaded Baggage</h2>
        {(!report.items || report.items.length === 0) && (
          <p className="text-xs text-muted-foreground">No offloaded baggage entries logged.</p>
        )}
        <div className="space-y-2">
          {report.items?.map((it) => (
            <ViewEntryCard key={it.entry_no} label={`Bag ${it.entry_no}`}>
              <p className="font-semibold text-foreground">
                Tag {it.baggage_tag_no}
                {it.weight_kg ? ` · ${it.weight_kg} kg` : ""}
              </p>
              {it.reason && <p className="mt-1 text-muted-foreground">{it.reason}</p>}
            </ViewEntryCard>
          ))}
        </div>
      </section>

      {report.remark && (
        <section className="card p-4 sm:p-5 space-y-2 border-border/80 bg-surface/80">
          <h2 className="section-title">Remark</h2>
          <p className="text-xs text-foreground leading-relaxed">{report.remark}</p>
        </section>
      )}

      {report.verified_by_dse_name && (
        <section className="card p-4 sm:p-5 space-y-3 border-primary/40 bg-card">
          <h2 className="section-title">DSE Verification</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Verified By" value={report.verified_by_dse_name} />
            <Field label="DSE Staff ID" value={report.verified_by_dse_id} />
          </div>
        </section>
      )}
    </div>
  );
}

export { formatTimeMY };
