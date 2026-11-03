# Aircraft Search Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements every task itself). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make aircraft search a verified, reviewed requirement of the departure turnaround: required only when the aircraft was on ground 4 h or more, had a night stop, or was towed from a hangar; evidenced by server-timed, GPS-reported start and finish; confirmed by a different on-duty SO/SSO/DSE; and timed against the SEC016 departure so a late or missing search is flagged and escalated, never hidden.

**Architecture:** Pure, unit-tested rules in `lib/avsec/aircraft-search/` (trigger, timing, minimum duration, GPS evidence, review eligibility) mirrored by one guarded forward migration of SECURITY DEFINER functions that are the authority: `start_aircraft_search_secure`, `finish_aircraft_search_secure` (called by the SEC029 form at the physical start and finish), a SEC029 submit hook that links the evidence, `review_aircraft_search_secure`, and a SEC016 departure hook that computes both gaps. Existing SEC016/SEC029 submit actions keep their structure; the direct "SEC029 clears the Bay Board" write is replaced by search states.

**Tech Stack:** Next.js server actions, Supabase RPCs/RLS, Node test runner, the guarded staging runner pattern (backup, dry run, live), Playwright hosted verifier.

**Spec:** the owner's approved rules (task brief of 2026-11-03, "Aircraft Search Verification"); inspected code: `lib/avsec/reports/actions.ts` (SEC016 ~L240-420, SEC029 ~L490-590), `lib/avsec/schemas/sec016.ts`, `sec029.ts`, `bay_board` table, `can_acknowledge_report`, `list_eligible_supervising_officers_secure`, `lib/avsec/duty/geofence.ts`.

## Findings from the inspection (what is true today)

- SEC016 departure flags a search only when `bay_board.on_ground_since` is 4 h or more AND the officer's own `aircraft_search_completed` checkbox is false. No link to a SEC029, no timing, no night stop, no tow.
- SEC029 submission clears the Bay Board entry directly (`cleared_at`, `cleared_by_report_id`), matched by station + registration only (not flight, not entity). `time_commence` / `time_completed` / `std` are staff-typed strings. The 30/45-minute minimum exists only as WOIS knowledge text, not as a check.
- SEC029's "Supervising Officer" is chosen by the submitter (eligible: SO/SSO/DSE of own team); nothing records a review decision. `report_acknowledgements` is a separate team acknowledgement.
- `bay_board` has no search state, tow flag or reason. Duty zones and `geofence.ts` (point-in-polygon, haversine) exist and are reused for location evidence.
- Report numbers come from `trg_set_report_no_*`; SEC029 submissions stay numbered by the existing trigger.

## Decisions this plan makes (the brief leaves them open; change here, not in code)

- **Night stop** = the aircraft's on-ground interval (arrival `on_ground_since` to departure SEC016 submission) includes 00:00 Malaysia time.
- **Towed from hangar** = a checkbox on the arrival SEC016 and the manual Bay Board entry, stored as `bay_board.towed_from_hangar`; the departure officer may also tick it at departure (stored on the departure record).
- **Operating entity / carrier**: AK = MAA, D7 = AAX. The carrier is taken from the submitter's single active entity membership (`leave_submitter_entity`), with the flight prefix (`AK`, `D7`) as a cross-check; a mismatch or no entity gives no link and is escalated.
- **Linking SEC029 to SEC016**: same station, same operating entity, same flight number (normalised upper-case) and same registration, SEC029 submitted within the departure's turnaround window (after the aircraft's arrival on the board, or within 24 h before the departure when there is no board entry). A different registration or flight is never evidence. Two or more matching SEC029 are a conflict: the earliest complete one is used, the rest are listed for the reviewer.
- **STD date**: SEC016 `sta_std` is a time of day; its date is the Malaysia date that puts it nearest the SEC016 submission (within 12 h either side). Shown as **staff-entered**.
- **Gaps** (minutes, from SEC029 submission): (1) to the staff-entered STD, (2) to SEC016 submission. Flag if either is under 45 (AK) or 90 (D7). Late means a gap below the threshold or a negative gap. Late or missing search needs a reason on the SEC016 and is escalated to the reviewer; the SEC016 is never blocked.
- **GPS**: location at start and at finish with server timestamps, reported accuracy stored. Wording everywhere: "reported location", never "proof of presence". GPS unavailable: submission allowed with a required reason, `presence_status = 'unverified'`, routed to review.
- **Minimum duration** from the SERVER start-to-finish times: 30 min A320/A321, 45 min A330; below minimum is an exception state (not a block) with a required reason.
- **Review**: reviewer is a different, currently on-duty SO, SSO or DSE of the same station and entity; the submitter, the assisting officer and the SEC016 submitter cannot review. One decision per search (row lock); states `pending`, `confirmed`, `exception`. A `confirmed` search is the only state that shows the Bay Board search as cleared.
- **Bay Board**: SEC029 submission sets `submitted`/`pending` (stays on the board). SEC016 departure removes the entry only when no search is required or the search is `confirmed`; otherwise it stays, marked departed without a confirmed search, and appears to the reviewer. Historical SEC029 and boards are untouched and marked `presence_status = 'historical_unverified'`, never retro-fitted as GPS verified.
- **Cabin crew aircraft security check** (the SEC016 `cabin_check` field) stays separate and is never accepted as a search.

## Global Constraints

- Production Supabase `zsxneokqulktgnccxgkz` and production Vercel untouched; no merge to `main`; staging only (`ddlctzbnqewubltcavkh`, `eswaran1/vecta-staging-preview`).
- Forward migrations only, guarded runner, fresh encrypted backup, dry run, rollback proof, live only if every gate passes; exact-ID fixture cleanup.
- Thresholds, verbatim: 4 hours on ground; 30 minutes A320/A321; 45 minutes A330; AK under 45 minutes; D7 under 90 minutes.
- Browser GPS is reported location evidence, not proof of physical presence; the real-aircraft device check is a separate physical trial.

## Review Focus

- Exactly 4 h 00 m 00 s on ground triggers; 3 h 59 m 59 s does not.
- Aircraft on ground across 00:00 MYT (night stop) with an arrival at 23:50 and departure at 00:20 triggers; SEC029 submitted 23:55 for a 00:30 STD gap crosses midnight correctly.
- A SEC029 for another aircraft or another flight, or from another station or entity, never satisfies the requirement.
- Duplicate SEC029 for one departure, and a SEC029 missing entirely, are flagged and escalated, not silently picked.
- GPS denied, timed out or very inaccurate; device clock wrong (server time is the authority).
- Two reviewers confirming at once: exactly one decision is recorded; a reviewer who is off duty or the submitter is refused.
- Delaying the SEC016 never turns a late search into a compliant one (gaps are computed from SEC029 submission, not from when the officer finally files the departure).

---

### Task 1: Pure rules

**Files:** Create `lib/avsec/aircraft-search/rules.ts`; Test `tests/aircraft-search-rules.test.mts`.

**Interfaces:**
- Produces:
  - `searchRequirement(input: { onGroundSinceMs: number; departureMs: number; towedFromHangar: boolean }): { required: boolean; reasons: ("ground_4h" | "night_stop" | "towed_from_hangar")[] }`
  - `minimumSearchMinutes(aircraftType: string): number | null` (30 for A320/A321, 45 for A330, null otherwise; accepts "A 320" and "A320")
  - `evaluateSearchDuration(startMs: number, finishMs: number, aircraftType: string): { minutes: number; belowMinimum: boolean; minimum: number | null }`
  - `carrierThresholdMinutes(carrier: "AK" | "D7"): 45 | 90`
  - `stdInstantMs(stdHHmm: string, referenceMs: number): number` (nearest Malaysia date within 12 h of the reference)
  - `evaluateTurnaroundGaps(input: { searchSubmittedMs: number; stdMs: number; departureSubmittedMs: number; carrier: "AK" | "D7" }): { stdGapMinutes: number; departureGapMinutes: number; stdFlag: boolean; departureFlag: boolean; flagged: boolean }`
  - `linkSearchToDeparture(departure: { station: string; entity: string; flight: string; registration: string }, searches: readonly SearchCandidate[]): { status: "linked"; searchId: string; duplicates: string[] } | { status: "missing" }` where `SearchCandidate = { id: string; station: string; entity: string; flight: string; registration: string; submittedMs: number; complete: boolean }`
  - `gpsEvidence(fix: { lat: number; lng: number; accuracyM: number } | null, reason: string | null): { presence: "reported" | "unverified"; ok: boolean; error?: string }` (null fix needs a reason of 5+ chars)
  - `mayReviewSearch(reviewer: { id: string; onDuty: boolean; role: "so" | "sso" | "dse" | string; station: string; entity: string }, search: { submitterId: string; assistantId: string | null; departureSubmitterId: string | null; station: string; entity: string }): { ok: boolean; reason?: string }`

- [ ] **Step 1: Write failing tests** named for each Review Focus line: exact 4 h boundary (14_400_000 ms triggers, 14_399_999 does not); night stop 23:50 arrival to 00:20 departure; tow alone triggers; A 320/A321 30 vs 29:59, A330 45 vs 44:59; AK 45 vs 44 min and D7 90 vs 89 min for BOTH gaps independently; STD 00:30 with SEC029 at 23:55 gives 35; negative gap flagged; mismatched flight/registration/station/entity never link; two matching give `duplicates`; GPS null without reason rejected, with reason `unverified`; reviewer: self, assistant, SEC016 submitter, off duty, wrong role, other station all refused; SO/SSO/DSE on duty accepted.
- [ ] **Step 2: Run** `node --experimental-strip-types --experimental-test-module-mocks --experimental-loader ./tests/loader.mts --test tests/aircraft-search-rules.test.mts`; expect module-not-found.
- [ ] **Step 3: Implement** the signatures above in `rules.ts` (Malaysia UTC+8, no DST).
- [ ] **Step 4: Run again;** expect all pass. **Step 5: Commit.**

### Task 2: Migration and guarded runner

**Files:** Create `supabase/migrations/20261203000004_aircraft_search_verification.sql`, `scripts/staging/apply-aircraft-search-migration.mjs`; Test `tests/aircraft-search-migration.test.mts`.

**Interfaces:**
- Produces tables/columns: `bay_board.towed_from_hangar boolean`, `bay_board.search_state text` (`not_required|pending|submitted|confirmed|exception`), `bay_board.search_reasons text[]`; `aircraft_search_records` (id, sec029_id unique, station, entity, flight, registration, aircraft_type, started_at server, start_lat/lng/accuracy, finished_at server, finish_lat/lng/accuracy, gps_unavailable_reason, presence_status `reported|unverified|historical_unverified`, duration_minutes, below_minimum, below_minimum_reason, review_state `pending|confirmed|exception`, reviewed_by, reviewed_at, review_note, departure_report_id, std_gap_minutes, departure_gap_minutes, late_flag, late_reason, created_at).
- Functions (all SECURITY DEFINER, fixed search_path, revoked from anon): `start_aircraft_search_secure(p_flight, p_registration, p_station, p_lat, p_lng, p_accuracy_m, p_unavailable_reason) returns uuid`; `finish_aircraft_search_secure(p_record_id, p_lat, p_lng, p_accuracy_m, p_unavailable_reason)`; `attach_search_to_sec029(p_record_id, p_sec029_id)` (also sets `bay_board.search_state='submitted'` and no longer clears the board); `review_aircraft_search_secure(p_record_id, p_decision text, p_note text) returns table(ok, code, message)`; `apply_departure_search_rules(p_departure_id uuid, ...)` called from the SEC016 departure path; `search_requirement_for_departure(...)`.
- [ ] **Step 1: Write failing source tests** (statements allow-listed; every function definer + revoked from anon; reviewer rules; row lock `for update`; no `delete`; historical default `historical_unverified`; SEC029 no longer clears `cleared_at`).
- [ ] **Step 2: Write the migration** mirroring Task 1 rules (point-in-zone reuse `handover_point_zone`; server time `clock_timestamp()`).
- [ ] **Step 3: Write the runner** from `apply-dse-report-notifications-migration.mjs`; probes (rolled back): every Review Focus line against real rows and a real DSE/SO/SSO identity, concurrent reviews, exact boundary durations, mismatched records, duplicate/missing SEC029, GPS-unavailable path, Bay Board states.
- [ ] **Step 4: Run tests and runner dry run;** expect all probes pass. **Step 5: Commit** (no live apply yet).

### Task 3: Server actions and forms

**Files:** Modify `lib/avsec/reports/actions.ts` (SEC029 and SEC016 departure paths), `lib/avsec/schemas/sec029.ts`, `sec016.ts` (departure reasons, tow flag); Create `lib/avsec/aircraft-search/actions.ts`; Modify `components/avsec/forms/Sec029Form.tsx` (Start search / Finish search with GPS, reason when GPS unavailable), SEC016 departure form (STD shown as staff-entered, both gaps, required reason), Bay Board list (search state); Create reviewer queue page `app/(avsec)/avsec/aircraft-search/page.tsx` and `components/avsec/aircraft-search/ReviewControls.tsx`; Test `tests/aircraft-search-actions.test.mts`.
- [ ] Write failing source/unit tests (SEC029 submit no longer writes `cleared_at`; SEC016 departure never rejects for a late search; reason required when flagged; cabin_check not read as search), implement, run full suite, commit.

### Task 4: Apply, Preview, hosted verification, physical trial

- [ ] Full gates (`npm test`, `tsc`, lint, build); fresh backup; dry run; live apply only if all pass; bump `expected-baseline` (114).
- [ ] Deploy Preview; hosted verifier `scripts/staging/verify-aircraft-search-hosted.mjs` with real sessions (desktop and mobile), exact-ID cleanup, honest note: browser location is emulated and does not certify presence.
- [ ] Physical aircraft trial procedure delivered with the report; phase reported separately with commit, migration, Preview URL, passes, failures and limitations.
