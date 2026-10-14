# CaterLink canonical workflow-gap audit

Application baseline: `6cf6eab2513194cda35c1315516c664240282718` (Part B certified). Staging `ddlctzbnqewubltcavkh`, 83 migrations, latest
`20261107000001`. Evidence is repository code, migrations and read-only / rolled-back probes on staging
(`scripts/staging/workflow-gap-probe.mjs`). Nothing here infers an aviation procedure that the repository does not state.

Classification: 1 Required and defined · 2 Required but requirements incomplete · 3 Intentionally deferred · 4 Superseded/retired · 5 Test/demo-only.

## 1. CaterLink workflow steps

State machine (single source: `lib/icms/workflow.ts`; **not enforced by any database trigger on `transactions`** on staging, where the
only triggers are the creation whitelist and the PDF-job enqueue; the legacy `enforce_part_*` functions exist but are attached to nothing):

| Direction / route | Sequence |
|---|---|
| Outbound AIRCRAFT | A → B → C → D |
| Outbound HUB | A → B → Hub (terminal) |
| Outbound REDQ | A → B → REDQ → C → D |
| Outbound MAINTENANCE | A → B → C (terminal) |
| Inbound | A → C → B (final) |

| Item | Route / component | Purpose | Authoritative source | Roles (legacy) | Station / entity scope | Prerequisite → result | DB objects | Audit / notify | PDF | Reachable | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Part B** | `/icms/transactions/[id]/part-b` | In-flight Security Post | Legacy action + form + workflow + canonical tables | `post2_avsec` → canonical station operator | origin/destination station with `scan`, on duty | CREATED → INFLIGHT_POST_APPROVED (inbound final → COMPLETED) | `record_caterlink_part_b_secure`, `part_b_c` (B), `seals`, `seal_verifications`, `caterlink_incidents` | audit + notify (escalation) | none for outbound | Yes, **certified** | 1 |
| **Part C** | `.../part-c` (stub) | Airport Security Post (Post 6); finalises MAINTENANCE; first inbound step | Legacy `completeChecklistPart`, `workflow.ts`; canonical `part_b_c` stage `C`, `seal_verifications.checkpoint = AIRPORT_POST` | `post6_avsec` (no canonical role mapping) | **Not defined**: legacy had no station concept; canonical scan exists only at PEN/JHB | INFLIGHT_POST_APPROVED (or REDQ_RESEALED / inbound CREATED) → AIRPORT_POST_APPROVED / COMPLETED | no write RPC | not defined | not defined | **Yes**: the scanner routes every post-B outbound and every inbound movement here | 2 |
| **Part D** | `.../part-d` (stub), orphan `components/icms/part-d-form.tsx` | Delivery to SRA warehouse / aircraft by the receiver | Legacy `completePartD`, canonical `caterlink_checkpoint_part_d` | `receiver` (no canonical mapping) | Not defined | AIRPORT_POST_APPROVED → COMPLETED | table only | not defined | **Legacy PDF generator reads absent `part_a..d`** | Yes (scanner), after C only | 2 (and possibly 4 — see Q5) |
| **Part Hub** | `.../part-hub` | Hub delivery confirmation at the destination | `confirm_caterlink_destination_receipt_secure` writes the same `caterlink_checkpoint_hub` row and completes the movement; `/avsec/caterlink/receipt` lists HUB movements for the destination station | `hub_avsec` | destination station with receipt capability | INFLIGHT_POST_APPROVED → COMPLETED | receipt RPC, `caterlink_checkpoint_hub` | audit + notify sender | durable receipt PDF job | **Fixed in this pass**: the placeholder now redirects to the receipt screen | **4** (superseded) |
| **REDQ re-seal** | `.../part-redq` (stub), orphan form | Replace seal at REDQ | Legacy `completePartRedq`, canonical `caterlink_checkpoint_redq` (old/new seal) | `redq_avsec` | Not defined | INFLIGHT_POST_APPROVED → REDQ_RESEALED | table only | not defined | not defined | Yes — **the Driver creation form offers the REDQ route** | 2 |
| **Skip Part D** | `.../skip-part-d` (stub) | Complete without Part D with a reason | Legacy `skip_part_d` (exists on staging, see §3) | `receiver` / `supervisor` | Not defined | AIRPORT_POST_APPROVED → COMPLETED | legacy `skip_part_d` | none | legacy generator | Stub only | 2 / 4 (see Q5) |
| **Incident report** | `.../incident` (stub), orphan `incident-form.tsx` | Report an incident from a movement | Legacy `reportIncident` ("any signed-in role", types, up to 5 photos); canonical `raise_caterlink_incident_secure` | any signed-in role (legacy) | any role in the AOC (canonical RPC) | any → ESCALATED | `raise_caterlink_incident_secure`, `caterlink_incidents` | audit; no notification | none | Stub only; **the RPC is callable directly** (§3) | 2 |
| **Resolve / reopen incident** | `/icms/incidents` | Management resolves; movement resumes | `resolve_caterlink_incident_secure`, `reopen_caterlink_incident_secure` | CaterLink Management, Operation Manager | AOC | ESCALATED → any status (default CREATED) | RPCs above | audit | none | Yes (functional, earlier certified) | 1 — resume-status rule open (Q6) |
| **Un-escalate button** | `components/icms/unescalate-button.tsx`, action `unescalateTransaction` | Legacy release | Calls `unescalate_transaction`, which **does not exist on staging**, then a fallback on the absent legacy `incidents` table | legacy | — | — | none | — | — | **Not rendered anywhere** (dead code) | 4 (superseded by resolve) |
| **Final receipt + PDF** | `/avsec/caterlink/receipt` | Destination receipt, durable PDF | `confirm_caterlink_destination_receipt_secure`, `caterlink_pdf_jobs` | station operators with receipt capability | destination station | any non-terminal status → COMPLETED (see §3) | RPCs, jobs, versions | audit + notify sender | authoritative versioned PDF | Yes, certified earlier | 1 — state rule open (Q4) |
| **Vendor Part B / C** | `/icms/vendor-transactions/...` | Vendor delivery | `record_caterlink_vendor_security_check_secure`, `complete_caterlink_vendor_delivery_secure` | scan-capable operator / owning Vendor | station / owner | per delivery | RPCs | audit | — | Yes | 1 |
| **Offline sync** | `app/api/icms/sync` | Replays queued submissions | Calls `completePartB` (works), `completePartC/D` and `reportIncident` (legacy tables, fail) | — | — | — | — | An automatic Part B escalation replayed offline returns "ok" and the hold instruction is never shown | — | Only for queued kinds | 2 |

Reversal / correction:
* After an **officer-chosen** Part B escalation, the `ESCALATE` record occupies the one-per-stage unique index. If management resolves
  the incident and the movement resumes at `CREATED`, `record_caterlink_part_b_secure` answers `ALREADY_RECORDED` and never advances the
  movement (a different officer is refused). Automatic escalations store no Part B record and can be redone. *Established from the
  function body; not executed.* The correction rule is a business decision (Q6).

## 2. Placeholder, dead-link and silent-failure inventory (whole application)

| Finding | Location | Effect | Class / action |
|---|---|---|---|
| "Not activated" placeholders | `part-c`, `part-d`, `part-redq`, `skip-part-d`, `incident` pages | Honest, but reachable from the scanner | 2 — unchanged, listed |
| Placeholder replaced by a redirect | `part-hub` | Was a dead end for HUB destinations | **Fixed** (4) |
| Conditional "not activated" states | `admin/audit`, `admin/users`, `incidents`, `transactions/new`, `vendor-transactions` | Only shown when a table/RPC is missing; all are functional on staging except `admin/users` (reads the legacy `users` shadow table that still exists) | 1 / 5 (`admin/users`) |
| Creation form offers routes that cannot complete as designed | `transactions/new` (Inbound, Hub, REDQ, Maintenance) | A Driver can create a movement whose next step is a stub; only the destination receipt completes it | 2 (Q1–Q3) |
| VECTA readers of the absent legacy `incidents` table | `app/page.tsx` (2), `admin/alerts`, `duty/handover-queries`, `dashboard/flight-detail`, `dashboard/needs-your-action` | Open escalations — including Part B's — never appeared in the home alert count, alerts, handover summary, flight detail or needs-action | **Fixed**: re-pointed to `caterlink_incidents` (RLS-scoped); regression test added |
| Handover summary read absent legacy `transactions` columns (`station`, `escort_officer_name`) | `duty/handover-queries.ts` | Unfinished-movement list was always empty | **Fixed** (station by id) |
| Overdue catering movement item reads absent `status_entered_at` | `needs-your-action.ts` | Item can never appear; needs an SLA definition | 2 (Q7) |
| Legacy completed-form PDF generator reads absent `part_a..d` | `lib/icms/completed-form-pdf.ts` (`generateCompletedFormPdf`) | Only reachable from the stubbed steps; the receipt PDF uses the canonical job path | 4 |
| Legacy actions without a working page | `completePartC/D/Hub/Redq`, `skipPartD`, `reportIncident`, `unescalateTransaction` | Dead code | 4 / 2 |
| SAT combined-report PDF bytes upload | `lib/phase8/workforce.ts` (documented "not implemented in this pass"), no caller | Metadata RPCs only | 3 (outside CaterLink; not part of this audit's scope) |
| WOIS "own leave status" | `lib/wois/tools.ts` | Documented gap | 3 |
| Swallowed errors | `.catch(() => undefined)` on service-worker registration and scanner stop only | Benign | — |
| Disabled operational buttons / TODO-FIXME affecting workflows | none found | — | — |

## 3. Security findings on staging (rolled-back probes, no data changed)

1. **`raise_caterlink_incident_secure` is open to any account holding any AOC role assignment.** Probe: `aso` (PEN), `aso-kul`,
   `aso-jhb`, `caterlink_management`, `aso-no-caterlink` **and `neg-pending-profile`** were each able to escalate (freeze) a movement
   they have no part in. Only the external Driver and Vendor were refused (cross-AOC). The function has no caller in the application
   but is callable through the data API. It does not check profile status, station, capability or duty.
2. **`skip_part_d` is executable by every authenticated user and its role gate fails open**: `current_user_role()` is `NULL` for canonical
   accounts and `NULL NOT IN (...)` is not true, so the role check never raises. Today only the order check stops a caller (status must
   be `AIRPORT_POST_APPROVED`, which no movement reaches because Part C has no write path). It becomes exploitable the moment Part C exists.
3. **Destination receipt completes a movement that never passed any checkpoint.** Probe: `aso-kul`, destination KUL, movement still
   `CREATED` → `COMPLETED` (rolled back). Only the HUB route requires `INFLIGHT_POST_APPROVED`.
4. **No database-level state machine** for Parts C/D/REDQ: the sequence lives only in application code.

None of these is changed by this pass because the correct rule is a business decision (below); (1) and (2) are recommended for a
single hardening migration as soon as Q8 is answered.

## 4. Decisions required (exact questions)

Q1. **Part C (Airport Post 6)** — at which station is it performed for a movement that originates at PEN/JHB: the origin station, the
destination station, or a separate airport post? Which canonical roles may perform it (ASO / SO / SSO / DSE, any others), must the
officer be on duty, and does it require the station `scan` capability (only PEN and JHB have it)?
Q2. **Inbound movements** — the first step is Part C (before B). Is the inbound flow in scope for the Malaysia trial? If so, who
performs C and B, and where?
Q3. **REDQ and MAINTENANCE routes** — are they offered to Drivers in the trial? If REDQ is: who re-seals, at which station, and how
are old/new seals recorded (new seal row, colour rules, whitelist)? If not: may the creation form hide them?
Q4. **Receipt vs checkpoints** — must the destination receipt require the movement to have passed Part B (and C/D) first? Today it
does not (except HUB).
Q5. **Part D and Skip** — is the destination receipt the replacement for Part D ("Delivery") on non-HUB routes, as it is for Hub? If
yes, Part D and Skip Part D are retired and the scanner must stop routing to them; if no, who is the "receiver", at which station?
Q6. **Correction after an incident** — after management resolves an incident, should the movement resume at the status before the
escalation (so a recorded Part B stands), or at `CREATED` with Part B redone as a new, versioned record? Who may choose the resume
status (it is currently any valid status typed by management)?
Q7. **Overdue / SLA** — what elapsed time makes a catering movement "overdue" at each status, and who is notified?
Q8. **Who may raise an incident** — recommended default: an approved profile that is a station operator at the movement's station
with an open duty row, plus CaterLink Management and Operation Manager; Driver and Vendor excluded. Confirm or amend. Should a
raised incident notify Management and the Operation Manager as the Part B escalation does?

## 5. Changes made in this pass (application only, no migration)

* Part Hub placeholder → redirect to the destination receipt.
* Five VECTA incident readers (and the handover summary's movement list) re-pointed to canonical tables; tests added.
* Read-only probe `scripts/staging/workflow-gap-probe.mjs`.
* Part B is untouched.

## 6. Fail-closed containment (migration `20261108000001`, prepared locally; not yet applied to staging)

* `skip_part_d` and `raise_caterlink_incident_secure` become fail-closed stubs and lose EXECUTE for PUBLIC, anon, authenticated and
  service_role. No verified internal process calls either: the Part B automatic escalation uses `caterlink_checkpoint_escalate_internal()`.
  The application Skip form and action, the legacy incident report and un-escalate actions/forms and the offline-sync kinds that wrote to
  absent tables were removed.
* The destination receipt locks the row, then accepts it only from the final-step state of the existing state machine (HUB / MAINTENANCE:
  `INFLIGHT_POST_APPROVED`; AIRCRAFT / REDQ / inbound: `AIRPORT_POST_APPROVED`, or its Phase 9 name `POST6_APPROVED`). Consequence for the
  trial: until Part C exists, only HUB and MAINTENANCE movements can be received; the other routes wait for the owner's answers (Q1–Q5).
* The "catering movement overdue" indicator is suppressed — **SLA configuration pending** (Q7) — rather than shown as zero.
