# VECTA Handover, Leave, Reports and Weather Design

Status: Approved by product owner on 2026-11-03. Implementation has not started in this working copy.

## Intent

Make shift handover harder to acknowledge remotely, clarify leave authority, give the DSE visibility into submitted reports, let officers resume SEC014 drafts across devices, and show useful station weather. These changes support staff using VECTA during real shifts. Each area is a separate implementation and staging-verification phase.

## 1. Optional, named shift handover

The outgoing officer may create a handover while on duty. Handover is never required to check out. Their identity comes from their session. They enter the receiving officer's staff ID; VECTA resolves and displays the officer's name. The match must be unique, approved, active, shift-based, at the same station, and different from the sender. Another team at that station is allowed. No match or ambiguous match prevents filing.

Filing records the notes and current unfinished-work snapshot, links the recipient profile, and sends that recipient an in-app alert. Only the linked recipient can acknowledge. Supervisors may view progress but cannot acknowledge for the recipient.

To complete the transfer, both officers must be checked in and physically meet. The outgoing phone displays a server-issued, single-use QR challenge valid for 60 seconds. The recipient scans it on their own device. At verification, both devices submit fresh locations captured within 30 seconds. The server checks each reported accuracy is at most 50 metres, each point is in an active duty zone at their station, and the reported positions are within 50 metres. A database transaction consumes the challenge and records the recipient, time, location evidence and acknowledgment exactly once. A failed or expired check leaves the record pending so staff can retry. There is no photo, manual code entry or supervisor override.

If the outgoing officer checks out before completion, or the duty date ends, the record is shown as Uncompleted. It remains an audit record without transferring responsibility. Historical handovers remain readable, and SEC016 continues to add a handover remark for a matching flight and station. Existing historical records are not retroactively treated as verified in person.

Browser GPS and QR scanning reduce casual remote acknowledgment but cannot prove a face-to-face meeting against collusion or location spoofing. The interface and audit export must describe the evidence accurately.

**Approaches considered:** A staff-ID lookup alone is quick but cannot enforce the recipient. A linked recipient, one-time challenge and server-side checks enforce the named workflow and are the chosen approach. Mandatory photos were rejected because they add sensitive data and can still be shared or fabricated.

## 2. Leave approval and cancellation

Unpaid leave duration uses inclusive calendar days. One or two days require final approval by an active Operation Manager for the request's Malaysia AOC scope. Three or more days require final approval by the Boss of the request's operating entity, MAA or AAX. Other approvers may see requests only where existing scope allows, but cannot supply the final approval for these unpaid-leave routes. The system determines the route from leave type, dates and the submitter's active assignment, never from client-provided role or entity fields. Rejection and approval create an audit record and notify the applicant.

A DSE may directly cancel an approved annual leave for a staff member in the DSE's own station and team. A nonempty reason is required. The Operation Manager may also directly cancel an annual-leave approval that was the fourth or later approval placing at least four distinct officers from that team on approved annual leave on one or more of the same calendar days. That exception status is recorded when the leave is approved, so later changes in the overlap count do not silently change cancellation authority. The approval cap must use this same-day rule. Cancellation is atomic, records actor, time, reason and prior status, updates roster and leave views, and notifies the officer. A repeated cancellation is rejected. Other leave types retain their existing cancellation-request workflow.

Direct cancellation is allowed for approved future annual leave and for leave currently underway. When leave is underway, previously taken calendar days, including the current Malaysia date, remain taken and auditable; cancellation releases only dates from the next Malaysia date onward. A completed past leave cannot be cancelled. The applicant's existing cancellation-request option remains available.

**Approaches considered:** Adding UI-only checks would leave the service-role action and database callable with broader authority. The chosen approach puts routing, scope, overlap marker and cancellation checks in guarded database functions, with thin UI actions.

## 3. DSE report copy and SEC014 drafts

When any security report is successfully submitted, VECTA creates a durable in-app notification for every active DSE assigned to the submitter's operating entity, station and team. The alert links to that report and identifies its form type, reference and submitter. Existing report read permissions still govern opening the link. Notification delivery is idempotent for a report and recipient. A missing DSE or notification failure does not undo a successfully submitted report; the failure is visible in technical monitoring for follow-up. This applies to SEC013, SEC014, SEC016, SEC018, SEC029, SEC033, Makeup and Breakup. Retired standalone Offload creation is excluded.

SEC014 gets an explicit Save Draft action for the whole form. The existing local autosave remains available offline, and a successful server save displays its time. On opening another device, the server draft is restored. If both a local and server draft exist, VECTA compares their save times and offers a clear choice when they differ, avoiding silent overwrite. Submission clears both copies only after a confirmed submission; a failed submission preserves the draft.

**Approaches considered:** Email CC depends on email configuration and exposes a second delivery path; the selected in-app alert follows VECTA's existing notification surface. Local-only drafts cannot reliably resume across devices; the chosen explicit server save builds on the existing `report_drafts` store.

## 4. Station weather

Every workspace for a role with a station assignment displays a small weather section for that station. It shows today's morning, afternoon and night forecasts, then a three-day outlook, using the official free Malaysia Weather API at `api.data.gov.my`. The card names the station, source and last update time. A server-side mapping connects VECTA station codes to the API's forecast locations; no browser geolocation or user-entered location is required. Server caching protects the public API and keeps workspace loading responsive. Missing mappings, unavailable data or expired data show a clear unavailable state rather than invented weather. Group-level roles without a station do not see a station-specific card.

The source supplies general forecasts, updated daily. The card does not claim live observed conditions, hourly precision or aviation weather clearance. Display the required CC BY 4.0 source attribution. The official API requires no key and is free to use, but its Weather endpoint is limited to four requests per minute; cache server-side and handle HTTP 429 without blocking a workspace.

**Approaches considered:** Google Weather supports hourly data but needs a configured billed key. Open-Meteo's free endpoint restricts commercial use. The chosen official Malaysian open-data source gives day-part and multi-day forecasts without those dependencies.

## Verification and rollout

Implement and review each phase independently. Add failing-first tests for role and station scope, thresholds, idempotency, draft conflicts, weather mapping and unavailable states. Run TypeScript, lint, the full application suite and build. For database changes, use forward migrations, a fresh encrypted staging backup and the repository's guarded transactional dry run before a live staging apply. Verify schema and role behavior from a fresh read-only connection after each apply. Deploy only to the dedicated Vercel Preview, confirm its commit and staging Supabase target, then run mobile and desktop hosted checks. Use exact-ID test fixtures and prove cleanup. Production remains untouched.

The handover phase also needs a real two-phone trial with two rostered staging accounts at a station. Browser emulation verifies flow and error states but cannot certify physical presence.
