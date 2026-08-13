# ICMS — Inflight Catering Management System

Reference document for understanding this app before making changes. Read this
first in any new session — it explains what the app does, who uses it, how
the workflow and guardrails work, and how deploys happen.

## What this is

ICMS digitizes the paper **IFCSF** (In-Flight Catering Security Form,
AA/SEC/F/010 Rev.01) workflow used at KUL airport: every catering vehicle
movement between the warehouse and the aircraft passes through a chain of
checkpoints (Part A → B → C → D), each one recorded, sealed, and signed
digitally instead of on paper. It replaces manual whitelist checks, manual
timing, and paper audit trails with database-enforced rules.

- **Repo**: `eswaran2728-lab/icms-airasia`
- **Production branch**: `master` → auto-deploys to `https://cscs-six.vercel.app` (Vercel)
- **Database**: Supabase Postgres, project `cscs` (`olqrjxirwrkgssqwsbip`)
- **Stack**: Next.js 15 (App Router, Server Actions, TypeScript), Tailwind CSS
  (shadcn-style components), Supabase (Postgres + Auth + Storage + RLS), Vercel hosting.
- The app was originally called CSCS (Catering Security Control System); some
  internal identifiers (`cscs_settings`, error message prefixes, demo emails)
  still use that name. User-facing branding is "ICMS."

## Roles

Six roles, stored as `users.role`. Accounts are created by an Admin (no
public self-service — new registrations require Admin approval, see below).

| Role (DB value) | Label shown in UI | What they do |
|---|---|---|
| `warehouse_pic` | Warehouse PIC | Creates transactions (Part A): picks direction, fills flight/vehicle/driver/cargo details, applies seals, does the vehicle search, signs. Covers both the in-flight catering warehouse and the SRA warehouse — direction is chosen per transaction, not tied to which warehouse. In practice (as of 2026-08-13) there is no dedicated warehouse clerk at some sites — the **driver themselves** signs in with their own individual account (own email, role `warehouse_pic`) and creates their own transaction, entering their own Driver ID/Name. See note below. |
| `post2_avsec` | AVSEC In-flight Post (Post 2) | Verifies vehicle/driver/seals at the in-flight security post (Part B). First checkpoint outbound, final checkpoint inbound. |
| `post6_avsec` | AVSEC Airport Post (Post 6) | Verifies vehicle/driver/seals at the airport security post (Part C). Second checkpoint outbound, first checkpoint inbound. |
| `receiver` | SRA / Aircraft Receiver | Confirms delivery (Part D) — outbound only, either at the SRA warehouse or aircraft side. |
| `enforcement` | Enforcement (added 2026-08-12) | Full parity with `supervisor` for incident resolution and Reports only — not whitelist/user-management/audit/archive, which stay supervisor-only. Does not perform checkpoint actions. |
| `supervisor` | **Admin** (label only — DB value stays `supervisor`) | Full oversight: approves registrations, manages users, manages the vehicle/driver/company whitelist, views the immutable audit log, runs reports, manages the transaction archive. Does not perform checkpoint actions. |

Every role sees a persistent role badge in the header (`{role label} · Staff
ID {staff_id}`), colored per-role via `ROLE_COLORS` in `constants.ts`, so it's
always unambiguous which post/role is acting — important because Post 2 and
Post 6 are easy to confuse. This is what "AVSEC role identification" refers
to in earlier work on this app.

**Operational note (driver-as-PIC, clarified 2026-08-13)**: where there's no
separate warehouse staff, each driver gets their own individual `users`
account (own email/login, role `warehouse_pic`) — logins are **not** shared
between drivers. That same person must *also* have a separate `drivers`
whitelist row (Staff ID + Name) for the whitelist/name-match checks in Part A
to pass — the login (`users`) and the whitelist entry (`drivers`) are two
different tables an Admin must set up independently for every such driver.
Because each driver has their own login, `part_a.created_by` / `pic_name` /
`pic_staff_id` correctly identify the specific driver who created each
transaction — there's no shared-account audit-trail gap.

### Registration & approval

New staff register via `/register` (name, staff ID, email, requested role,
password). This creates a `users` row with `status = 'pending'`. They cannot
sign in until an Admin approves them (`/admin/users` → pending approvals),
which flips `status` to `active` (or `rejected`). `requireProfile()` checks
`status === 'active'` on every request — even an already-open session gets
signed out if status changes mid-session.

## Core workflow: Part A → B → C → D

Direction is chosen at creation and determines the checkpoint order. This is
enforced both in `src/lib/workflow.ts` (`WORKFLOWS` — single source of
truth) and mirrored in Postgres by `enforce_part_sequence()`, so a checkpoint
can't be submitted out of order or twice, from either the client or the DB.

**OUTBOUND (departure, BLUE seal convention)**
`A (Warehouse PIC) → B: In-flight Post (Post 2) → C: Airport Post (Post 6) → D: Delivery (Receiver)`

**INBOUND (arrival, GREEN seal convention)**
`A (Warehouse PIC) → C: Airport Post (Post 6) → B: In-flight Post (Post 2, FINAL — no Part D)`

Transaction status progresses `CREATED → INFLIGHT_POST_APPROVED /
AIRPORT_POST_APPROVED (order depends on direction) → COMPLETED`, or jumps to
`ESCALATED` the moment any incident is raised against it (freezes checkpoint
processing until an Admin resolves it).

### Part A (creation) — Warehouse PIC

Captures: direction, flight number, aircraft reg, catering company, station,
vehicle number, driver ID + name, optional escort officer (name + staff ID +
**escort vehicle number** — all three are all-or-nothing, NOT whitelist-checked,
see below), cargo type checklist (Food & Beverage / Perishable / Duty Free /
Merchandise / Vehicle Maintenance, per IFCSF), item counts
(carts/SMU/pallets/boxes/oven racks), one or more seals (number + type +
manually-picked color), vehicle search confirmation, and a digital signature.
Generates the transaction number (`ICMS-YYYY-000001`, per-year Postgres
sequence) and a signed QR pass. Vehicle/Driver ID fields require manual
typing — no browser autocomplete/pick-list of whitelisted values (removed
2026-08-13, same rationale as Part B/C observed-field auto-fill removal).

**Hard block**: the vehicle and driver must both resolve to an active
whitelist entry, or Part A is rejected outright (`WHITELIST_VIOLATION`) —
both client-side, in the server action, and by a DB trigger
(`enforce_whitelist_on_create`), so no insert path can bypass it. As of
2026-08-13, the typed **Driver Name** must also match the whitelisted name on
file for that driver ID (case/whitespace-insensitive) — an ID alone can no
longer wave through a different, unlisted person driving the vehicle; same
`WHITELIST_VIOLATION` severity, same three-layer enforcement. An expired pass
on an otherwise-whitelisted vehicle/driver is a *different*, explicit escape
hatch — the PIC can record it anyway, which auto-raises an `EXPIRED_PASS`
incident instead of hard-blocking.

**Escort officer/vehicle is NOT whitelist-checked** (changed 2026-08-13):
escort staffing and vehicles rotate and were never registered catering
entries, so requiring a whitelist match was blocking legitimate escorts. Only
the all-or-nothing pairing rule (`transactions_escort_pairing_check`) still
applies — name, staff ID and vehicle number must be filled together or all
left blank; none of the three are checked against `vehicles`/`drivers`.

### Part B / Part C (checkpoints) — AVSEC Post 2 / Post 6

Officer scans the QR pass (or enters the transaction number manually),
enters what they **physically observe** — vehicle number, driver name,
driver ID — with no auto-fill from Part A (removed deliberately, so officers
type what they see rather than confirming a pre-filled value). Verifies each
seal's number and color against what was recorded at Part A. A mismatch (or
observed vehicle/driver not on the active whitelist — secondary
defense-in-depth check) forces `ESCALATE`; there is no way to force a `PASS`
through a mismatch.

### Part D (delivery) — Receiver

Outbound only. Confirms delivery location (SRA Warehouse or Aircraft),
receiver signature. Completes the transaction. A supervisor can skip Part D
in specific cases (`/transactions/[id]/skip-part-d`).

### Per-segment checkpoint timeouts

Each `(direction, from_status)` segment has its own SLA in
`segment_timeouts` (not a flat timeout):

| Direction | Segment | Limit |
|---|---|---|
| OUTBOUND | Created → In-flight Post approved | 30 min |
| OUTBOUND | In-flight Post → Airport Post approved | 45 min |
| OUTBOUND | Airport Post → Completed | no limit |
| INBOUND | Created → Airport Post approved | 30 min |
| INBOUND | Airport Post → Completed | 45 min |

A pg_cron job (`escalate_timeouts()`, every 15 min) raises a
`SEGMENT_TIMEOUT` incident (once per transaction) when a segment overruns.
This incident type has a **lighter** lifecycle (`OPEN → RESOLVED`, no forced
`UNDER_REVIEW`/`CLOSED`) since it's operational noise, not a security event —
every other incident type keeps the full `OPEN → UNDER_REVIEW → RESOLVED →
CLOSED` lifecycle. The transaction detail page shows a live countdown to the
next checkpoint's deadline.

## Data model (key tables)

- **`users`** — profile + role + `status` (pending/active/rejected), linked to Supabase Auth.
- **`transactions`** — one row per movement. Direction, status, `status_entered_at`
  (SLA clock, bumped only on status change — not on unrelated updates like archiving),
  flight/vehicle/driver/escort fields, `vehicle_id`/`driver_id_ref` (FK into the whitelist,
  set only when Part A matched an active entry — null means unwhitelisted).
- **`part_a` / `part_b` / `part_c` / `part_d`** — one row per checkpoint, **write-once**
  (UPDATE/DELETE blocked by trigger once inserted).
- **`seals`** / **`seal_verifications`** — sealed at Part A, verified at each checkpoint. Also write-once.
- **`incidents`** — escalations. Types: `BROKEN_SEAL`, `SEAL_MISMATCH`, `UNAUTHORIZED_DRIVER`,
  `UNAUTHORIZED_VEHICLE`, `EXPIRED_PASS`, `WRONG_SEAL_COLOR`, `TIMEOUT` (legacy), `OTHER`,
  `WHITELIST_VIOLATION`, `SEGMENT_TIMEOUT`. Raising one forces the transaction to `ESCALATED`.
  Facts (type/description/reporter) are immutable once created; only the resolution status can advance.
- **`catering_companies` / `vehicles` / `drivers`** — the whitelist. `is_active` soft-deactivates
  (never hard-deleted historically — see below for the one exception). Vehicles carry
  `truck_type` (Hi-Lift / Bonded Truck, required) and `truck_registration_number` (internal
  fleet code, e.g. "IFS 12" — distinct from `vehicle_number`, the actual plate). Drivers carry
  `staff_id` (renamed from `driver_id` — see history below), `swap_to_staff_ic` +
  `staff_ic_number` (masked `XXXXXX-XX-XXXX`, only when a driver's pass ID differs from their
  staff IC), and `pass_expiry_date` (labeled "ADP Expiry Date" in the UI).
- **`audit_logs`** — immutable, every INSERT/UPDATE/DELETE on core tables, who/what/when/before/after.
- **`segment_timeouts`** — SLA config table, see above.

## Guardrails (enforced in Postgres, not just the UI)

This app follows **defense-in-depth** everywhere: every rule is checked
client-side (fast feedback), in the server action (real check), and again by
a Postgres trigger/RLS policy (can't be bypassed by any insert path,
present or future). When adding a new rule, follow this same three-layer
pattern.

- Transaction numbers are generated server-side by a trigger — never client input.
- Checkpoints can only be inserted in the direction-correct order (`enforce_part_sequence`).
- Any incident insert forces `ESCALATED` and freezes further checkpoint processing.
- Part/seal/audit records are write-once — UPDATE and DELETE are blocked by `block_mutation()`
  triggers (`trg_*_immutable` / `trg_*_no_delete`), **except** `vehicles` and `drivers`, which
  as of 2026-08-11 allow hard delete — see below.
- Completed transactions can't be modified; the only path forward is an incident (re-escalation).
- Vehicle/driver whitelist checks are hard blocks (Part A creation *and* Part B/C checkpoints),
  not soft warnings — this was a deliberate upgrade from an earlier "warn but allow" design.
- RLS restricts each role to its own part; only `supervisor` sees audit logs and all users.

### Whitelist hard-delete (added 2026-08-11)

`vehicles` and `drivers` originally could only be deactivated, never deleted
(matching every other table's audit-preservation posture). This was
deliberately relaxed: `trg_vehicles_no_delete` / `trg_drivers_no_delete` were
dropped, so the admin UI now has a real "Delete" button. Safety comes from
the existing FK instead of a blanket trigger:
`transactions.vehicle_id` / `driver_id_ref` are `ON DELETE NO ACTION`, so
deleting a vehicle/driver that any transaction ever referenced fails with a
friendly "has transaction history, deactivate instead" message — verified
live against a real transaction before shipping. Deactivation remains the
default; delete is for rows that were never actually used (e.g. entered by mistake).

## Admin features (`supervisor` / "Admin" role)

- **`/admin/whitelists`** — manage companies, vehicles, drivers. Add forms default company to
  IFC. Vehicle add requires Truck Type (Hi-Lift/Bonded Truck). Driver add has a
  "Swap to Staff IC" toggle revealing a masked/validated IC input. Every row has
  Deactivate/Reactivate *and* Delete (delete fails safely if the row has transaction history).
- **`/admin/users`** — approve/reject pending registrations, create/edit users, assign roles.
- **`/admin/audit`** — read-only immutable audit trail.
- **`/admin/archive`** — archived (old/completed) transactions, kept out of the main list.
- **`/reports`** — daily/monthly reports, PDF and Excel export. `enforcement` also has full
  access to this page (and to resolving incidents) — everything else above stays supervisor-only.

## Other features

- **QR pass** — every transaction gets a signed QR token (`src/lib/qr-token.ts`), scanned at
  each checkpoint (`/scan`, camera + manual fallback). Checkpoint order is enforced
  server-side regardless of how the transaction was opened.
- **PWA / offline** — installable (manifest + service worker), queues checkpoint submissions
  made while offline and replays them on reconnect (`src/components/pwa-provider.tsx`). An
  install-prompt banner (added 2026-08-11, `src/components/install-prompt.tsx`) offers a
  one-tap install via the browser's native `beforeinstallprompt` flow (Chrome/Edge/Android only
  — iOS Safari has no equivalent API).
- **Bilingual** — English / Bahasa Melayu toggle; error messages throughout are bilingual.
- **Signatures & photos** — stored in private Supabase Storage buckets, rendered via 1-hour
  signed URLs.
- **Design system** — gold primary (`#CAA52B`) + AirAsia red brand accent (`#EF2F25`), Plus
  Jakarta Sans (headings) + Inter (body) + IBM Plex Mono (added 2026-08-11, for all identifier
  codes: transaction numbers, plate numbers, staff IDs, seal numbers — wired via Tailwind's
  `font-mono` utility, which the codebase already used extensively). Dark theme on
  login/register, light on the rest of the app. A Claude Design mobile mockup handoff
  (2026-08-11) confirmed the app's existing theme was already consistent with a from-scratch
  mobile redesign — see "Upgrade history" below.

## Project structure

```
supabase/migrations/     SQL migrations — schema, triggers, RLS, seed/data migrations
scripts/seed.mjs         Seed demo users + transactions (local/dev only)
src/middleware.ts        Session refresh + auth gate
src/lib/supabase/        Browser / server / service-role Supabase clients
src/lib/actions/         Server actions (auth.ts, transactions.ts, whitelists.ts, users.ts, ...)
src/lib/workflow.ts       Single source of truth for the checkpoint sequence
src/lib/constants.ts      Role/status/incident labels and colors
src/lib/database.types.ts TypeScript types mirroring the DB schema
src/app/login/            Sign in
src/app/register/         Self-registration (pending admin approval)
src/app/(app)/dashboard/  KPI cards + charts
src/app/(app)/scan/       Camera QR scanner + manual fallback
src/app/(app)/transactions/          List + search
src/app/(app)/transactions/new/      Part A
src/app/(app)/transactions/[id]/     Detail, QR pass, Part B/C/D, incident, skip-part-d
src/app/(app)/incidents/             Incident log + new incident
src/app/(app)/reports/               Reports, PDF/Excel export
src/app/(app)/admin/whitelists/      Companies/vehicles/drivers management
src/app/(app)/admin/users/           User management + pending approvals
src/app/(app)/admin/audit/           Immutable audit trail
src/app/(app)/admin/archive/         Archived transactions
```

## How deploys work

There is **no staging environment** — `master` is production, auto-deployed
by Vercel on every push. The established pattern in this repo:

1. Develop on a feature branch (has been `claude/icms-role-identification-b92put`
   throughout this history).
2. Typecheck (`npx tsc --noEmit`) and lint (`npx next lint`) must both be clean.
3. For schema/data changes: write a migration file in `supabase/migrations/`
   (never hand-edit production data), apply it live via the Supabase MCP
   `apply_migration` tool, and verify the result with a read query before
   moving on.
4. Commit, push the feature branch, fast-forward merge into `master`, push
   `master` — this triggers the Vercel deploy.
5. For anything with real user-facing or data impact, show the user a diff/plan
   summary and get explicit confirmation before the `master` push — this has
   been a consistent, explicit requirement in this project.

**Caveat learned the hard way**: renaming or dropping a column updates
everything Postgres tracks as a dependency (views, FKs) automatically, but
**not** PL/pgSQL function bodies — they're stored as plain text. After
renaming `drivers.driver_id` → `staff_id`, one trigger function
(`enforce_secondary_whitelist`) still referenced the old name and broke every
Part B/C checkpoint save until caught and hotfixed. When renaming a column,
grep the *live database's* function bodies too, not just the migration files:

```sql
select proname, prosrc from pg_proc
where prosrc ilike '%old_column_name%';
```

## Upgrade history (chronological, most recent first)

- **2026-08-13**: Removed browser autocomplete/pick-list from Part A Vehicle Number, Driver ID
  and Escort Vehicle Number fields (manual typing only, mirrors the Part B/C auto-fill removal).
  Part A now also validates that the typed Driver Name matches the whitelisted name on file for
  the entered driver ID (`WHITELIST_VIOLATION` if not — a real driver ID could otherwise be
  entered with a different, unlisted person's name). Escort officer/vehicle whitelist check
  removed entirely — escort staffing rotates and isn't a registered catering entry; only the
  all-or-nothing pairing rule remains.
- **2026-08-12**: Added the `enforcement` role — full parity with `supervisor` for incident
  resolution and Reports, but not for whitelist/user-management/audit/archive (those stay
  supervisor-only). Enabled by widening the existing `transactions` RLS policy (checkpoint +
  supervisor read) and the `incidents` RLS policy, exploiting the "read follows transaction
  visibility" cascade that most other tables (`part_a/b/c/d`, `seals`, `incidents`) already use —
  meant only 2 policies needed touching, not 7. `ROLE_COLORS` added to `constants.ts` for
  per-role header badge coloring (previously all roles shared one badge style).
- **2026-08-11**: Install-app prompt banner. IBM Plex Mono applied app-wide to identifier
  codes (following a Claude Design mobile mockup handoff that confirmed the existing theme
  already matched). Whitelist hard-delete added (with FK-based safety). Real IFC driver/vehicle
  roster loaded from official PDFs, replacing seed/demo whitelist data (demo rows deactivated,
  a few truly-unused ones hard-deleted). Vehicle whitelist form simplified (dropped Pass No.,
  added required Truck Type + Truck Reg. No., defaults company to IFC). Driver whitelist form
  simplified (Pass No. → Staff ID rename plumbed everywhere, "Swap to Staff IC" toggle +
  masked IC field, expiry field relabeled "ADP Expiry Date"). Fixed a production bug where the
  driver_id→staff_id rename broke Part B/C checkpoint saves (trigger function body wasn't
  auto-updated by the rename).
- **2026-08-10 and earlier same window**: Removed auto-fill of observed vehicle/driver at Part
  B/C checkpoints (officers must type what they observe). Live countdown to next checkpoint
  deadline on the transaction detail page.
- **Five-upgrade batch** (AVSEC role identification badges; strict vehicle/driver whitelist
  enforcement replacing soft warnings with hard blocks at both Part A creation and Part B/C
  checkpoints; escort vehicle number field, paired all-or-nothing with escort officer
  name/staff ID; per-segment checkpoint SLA timeouts replacing a flat 4-hour timeout).
- Earlier phases (visible in migration filenames): direction-aware workflow, seals, QR tokens,
  whitelists, incidents, audit hardening, bilingual support, role handoff/rebrand from CSCS to
  ICMS, Part D seal color, admin archive, self-registration, IFCSF amended fields, completed-form
  PDF, merged warehouse roles, IFC catering company.

## Tips for future upgrades

- Match the existing defense-in-depth pattern for any new rule: client validation → server
  action check → DB trigger/constraint. Don't rely on just one layer.
- Whitelist/audit tables prefer soft-deactivation. Only add real hard-delete where there's a
  genuine reason (as done for vehicles/drivers), and only when a FK or equivalent check can
  make it fail safely rather than corrupt history.
- New identifier-type fields (codes, IDs, plate numbers) should get `className="font-mono"`
  for consistency with the rest of the app.
- Always write a migration file for schema/data changes — never hand-edit the live DB outside
  of one — and double check the live database's function bodies (not just migration source)
  when renaming a column that any trigger might reference.
- This is a live production app with real users. Confirm before merging to `master` when a
  change affects real data, workflow behavior, or is otherwise hard to reverse.
