import { SEC029_ITEMS } from "@/lib/reference-data";
import { formatDateTimeMY, formatDateMY, formatTimeMY } from "@/lib/datetime";
import type {
  Sec016Row,
  Sec014Row,
  Sec014PatrolEntry,
  Sec029Row,
  Sec029ItemEntry,
  Sec018Row,
  Sec018PatrolEntry,
} from "@/lib/types";

export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="text-sm font-medium break-words">{value === "" || value == null ? "—" : value}</p>
    </div>
  );
}

export function ViewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-5 space-y-3">
      <h2 className="section-title">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
    </section>
  );
}

export function Sec016View({ report }: { report: Sec016Row }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff No" value={report.staff_no} />
        <Field label="Date" value={formatDateMY(report.duty_date)} />
        <Field label="Duty Hour" value={report.duty_hour} />
      </ViewSection>

      <ViewSection title="Aircraft">
        <Field label="Flight" value={report.flight} />
        <Field label="Origin Arr / Dep" value={report.origin_arr_dep} />
        <Field label="Assisted By" value={report.assisted_by} />
        <Field
          label="Aircraft Type"
          value={report.aircraft_type === "Other" ? report.aircraft_type_other : report.aircraft_type}
        />
        <Field label="Reg No" value={report.reg_no} />
        <Field label="Bay No" value={report.bay_no} />
        <Field label="STA / STD" value={report.sta_std} />
        <Field label="ATA / ATD" value={report.ata_atd} />
        <Field label="Reason for Delay" value={report.reason_for_delay} />
        <Field label="D/O INFMD" value={report.do_infmd} />
        <Field label="Inbound Baggage" value={report.inbound_baggage} />
        <Field label="Outbound Baggage" value={report.outbound_baggage} />
        <Field label="Inbound Cargo" value={report.inbound_cargo} />
        <Field label="Outbound Cargo" value={report.outbound_cargo} />
        <Field label="Inbound Co-Mail / Comart" value={report.inbound_co_mail} />
        <Field label="Outbound Co-Mail / Comart" value={report.outbound_co_mail} />
        <Field label="Checked" value={report.checked_items?.join(", ")} />
        <Field label="Shift Leader" value={report.shift_leader} />
        <Field label="Ramp Staff 1" value={report.ramp_staff_1} />
        <Field label="Ramp Staff 2" value={report.ramp_staff_2} />
        <Field label="Ramp Staff 3" value={report.ramp_staff_3} />
        <Field label="Ramp Staff 4" value={report.ramp_staff_4} />
        <Field label="Ramp Staff 5" value={report.ramp_staff_5} />
        <Field label="Cargo Hold Checked" value={report.cargo_hold_checked} />
        <Field label="Staff Frisked" value={report.staff_frisked} />
        <Field label="Discrepancies" value={report.discrepancies} />
      </ViewSection>

      <ViewSection title="Offload Information (Departure Flight)">
        <Field label="Flight No" value={report.offload_flight_no} />
        <Field label="Destination" value={report.offload_destination} />
        <Field label="Baggage Tag No" value={report.offload_baggage_tag_no} />
        <Field label="Total Baggage" value={report.offload_total_baggage} />
        <Field label="Remark" value={report.offload_remark} />
      </ViewSection>
    </div>
  );
}

export function Sec014View({ report }: { report: Sec014Row & { patrols?: Sec014PatrolEntry[] } }) {
  return (
    <div className="space-y-4">
      <ViewSection title="Staff Details">
        <Field label="Station" value={report.station} />
        <Field label="Team" value={report.team} />
        <Field label="Name" value={report.staff_name} />
        <Field label="Staff ID" value={report.staff_id} />
        <Field label="Date & Time In" value={formatDateTimeMY(report.date_time_in)} />
        <Field label="Date & Time Out" value={formatDateTimeMY(report.date_time_out)} />
      </ViewSection>

      <section className="card p-4 sm:p-5 space-y-3">
        <h2 className="section-title">Patrolling</h2>
        {(!report.patrols || report.patrols.length === 0) && (
          <p className="text-sm text-slate-500">No patrol entries logged.</p>
        )}
        <div className="space-y-2">
          {report.patrols?.map((p) => (
            <div key={p.entry_no} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <p className="font-semibold">
                Entry {p.entry_no} — {p.location ?? "—"} · {p.time_from ?? "—"}–{p.time_to ?? "—"}
              </p>
              <p className="text-slate-600 dark:text-slate-300">{p.description}</p>
            </div>
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

      <section className="card p-4 sm:p-5 space-y-2">
        <h2 className="section-title">Checklist</h2>
        {SEC029_ITEMS.map((item) => {
          const entry = itemMap.get(item.code);
          if (!entry) return null;
          const flagged = entry.checked === "NO" || entry.remark_type === "other";
          return (
            <div
              key={item.code}
              className={
                "flex items-center justify-between rounded-md border px-3 py-2 text-sm " +
                (flagged
                  ? "border-amber-400 bg-amber-50 dark:bg-amber-500/10"
                  : "border-slate-200 dark:border-slate-800")
              }
            >
              <span>{item.label}</span>
              <span className="font-semibold shrink-0 ml-2">
                {entry.checked}
                {entry.remark_type === "other" && entry.remark_text ? ` — ${entry.remark_text}` : ""}
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

      <section className="card p-4 sm:p-5 space-y-3">
        <h2 className="section-title">Patrolling Details</h2>
        {(!report.patrols || report.patrols.length === 0) && (
          <p className="text-sm text-slate-500">No patrol entries logged.</p>
        )}
        <div className="space-y-2">
          {report.patrols?.map((p) => (
            <div key={p.entry_no} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-sm">
              <p className="font-semibold">
                Entry {p.entry_no} — {p.time_from ?? "—"}–{p.time_to ?? "—"} · Bay {p.parking_bay ?? "—"} ·{" "}
                {p.aircraft_type ?? "—"} · {p.reg_no ?? "—"}
              </p>
              <p className="text-slate-600 dark:text-slate-300">{p.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export { formatTimeMY };
