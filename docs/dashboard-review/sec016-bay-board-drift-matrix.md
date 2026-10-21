# SEC016 / Bay Board hosted drift matrix (read-only evidence, 2026-10-21)

Method: the **canonical** definition is the repository's complete migration chain (a copy of the local PGlite golden database); the **hosted** definition
was read from the approved staging project (`ddlctzbnqewubltcavkh`) inside `BEGIN READ ONLY` over verified TLS (catalog selects only, no row data).
Hosted is a PostgreSQL 17 database; the local catalog stores NOT NULL as `pg_constraint` rows of type `n` (catalog noise, excluded below).

## Root cause
Staging never received `20260911000005` (SEC016 arrival/departure + Bay Board link), `20260914000001` (SEC016 Rev.03 direction fields) nor the
`20260911*` / `20260915*` / `20260924*` multi-tenant and ops_group scaffolding. The first hosted transactional dry run (2026-10-21) therefore failed at
`23502 null value in column "inbound_baggage"`; the failure rolled back and staging was proven unchanged.

## `public.report_sec016` (canonical 70 columns, hosted 61)
| Difference | Canonical | Hosted | Affects a reachable workflow? | Handled by the revised `20261117000001` |
|---|---|---|---|---|
| `flight_type` | text NOT NULL default `'arrival'` + check (`arrival`,`departure`) | missing | **Yes** – `submitSec016()` inserts it | yes (existing reviewed statement) |
| `aircraft_search_completed` | boolean NOT NULL default false | missing | **Yes** – inserted | yes |
| `search_overdue_flag` | boolean NOT NULL default false | missing | **Yes** – inserted | yes |
| `search_remark` | text, nullable | missing | **Yes** – inserted | yes |
| `ramp_agents_baggage` | text, nullable | missing | **Yes** – inserted (rev03) | **yes (new)** |
| `ramp_agents_cargo` | text, nullable | missing | **Yes** – inserted (rev03) | **yes (new)** |
| `cabin_check` | text, nullable | missing | **Yes** – inserted (rev03) | **yes (new)** |
| `ops_group` | text, nullable, no default | missing | **Yes** – `submitSec016()` still sends `ops_group: null` ("historical column") | **yes (new; not in the original three)** |
| 16 legacy columns (`outbound_baggage`, `outbound_cargo`, `outbound_co_mail`, `inbound_baggage`, `inbound_cargo`, `inbound_co_mail`, `ramp_staff_1..5`, `offload_flight_no`, `offload_destination`, `offload_total_baggage`, `offload_baggage_tag_no`, `offload_remark`) | nullable (relaxed by 20260914000001) | **NOT NULL** | **Yes** – the form sends null / omits them (`23502`) | **yes (new: 16 × `drop not null`)** |
| `org_id` (uuid, default, FK `organizations`) + `idx_report_sec016_org_id` | present | missing | **No** – no reachable code or function reads or writes it; hosted has no `organizations` table | no (deliberately not added) |
| `report_sec016_flight_type_check`, `idx_report_sec016_flight_type`, `idx_report_sec016_station_reg` | present | missing | indexes/check come with the columns | yes (existing statements) |
| Triggers (8), RLS (enabled, not forced), policies (3: own select / own update / canonical own insert) | identical | identical | – | untouched |
| Trigger functions `set_updated_at`, `set_report_no_sec016`, `enqueue_sheet_sync` | identical bodies (only `pg_get_functiondef` formatting differs) | – | – | untouched |
| Column-level SELECT grants (`id, profile_id, report_no, submitted_at`) | identical | identical | – | untouched |
| Table grants `REFERENCES / TRIGGER / TRUNCATE` for `authenticated` | absent in the local stub | present (Supabase platform default privileges) | no | untouched (never changed by a migration) |

## `public.bay_board`
| Difference | Canonical | Hosted | Reachable? | Handled |
|---|---|---|---|---|
| `flight` text, `is_manual` boolean NOT NULL default false, `arrival_report_id` / `departure_report_id` uuid → `report_sec016(id)` | present | missing | **Yes** – arrival insert, departure clear, manual entry, `get_bay_board_secure()` (`42703 b.flight`) | yes (existing reviewed statements) |
| FK `bay_board_cleared_by_report_id_fkey` → `report_sec029` | dropped | present | **Yes** – rejects a SEC016 id in `cleared_by_report_id` | yes (dropped) |
| `idx_bay_board_match`, `idx_bay_board_arrival_report` | present | missing | performance of the same paths | yes |
| `org_id`, `bay_board_org_id_fkey`, `idx_bay_board_org_id` | present | missing | **No** | no (not added) |
| Policies (`bay_board_scoped_select/insert/update` = `canon_station_visible(station)`), triggers, RLS, `get_bay_board_secure` ACL / hardening | identical | identical | – | untouched |
| Table-level grants to `authenticated` (INSERT/SELECT/UPDATE) | column-level in the local chain | table-level | no – table-level grants cover the new columns automatically | untouched |

## Other hosted drift found (OUT OF SCOPE, reported, not fixed here)
105 canonical columns across 35 tables are missing on hosted (e.g. `ops_group` and `org_id` on `report_sec013/014/018/029/033`, `duty_records`,
`overtime_requests`, `offload_records`, `profiles`, `users`; whole tables `organizations`, `feedback_*`, `kb_*`, `announcement_targets`). The application
still writes `ops_group: null` on SEC014 / SEC029 / SEC018 / SEC033 / duty inserts, so those hosted workflows are expected to fail the same way
SEC016 did. They need their own evidence-based reconciliation; they were not changed here.

## What the revised migration contains (and does not)
Adds `ramp_agents_baggage`, `ramp_agents_cargo`, `cabin_check`, `ops_group` (all `text`, nullable, no default) to `report_sec016`; drops NOT NULL on exactly the
sixteen legacy columns; retains the previously reviewed SEC016 / Bay Board reconciliation. No `org_id`, no policy / grant / trigger change, no backfill, no
replay of historical migrations. Every statement is idempotent; existing rows are preserved (values unchanged, new columns take only their defaults).
