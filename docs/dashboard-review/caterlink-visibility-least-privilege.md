# CaterLink movement visibility: least privilege

Migration `20261119000001_caterlink_least_privilege_transaction_read` (staging runner: `scripts/staging/apply-caterlink-visibility-migration.mjs`).

## Defect (observed on staging, 22 October 2026)

`public.transactions_read_policy` allowed any approved profile with an active assignment at a movement's **origin or destination station** to read the
movement (`has_station_assignment_for_transaction(aoc_id, destination_station_id, origin_station_id)`), whatever its role. Seals, Part A checkpoints and
signature objects derive their visibility from the movement (EXISTS-based policies and `caterlink_signature_visible`), so they were exposed with it.
Observed consequence: `profiling_aso` and `aso`, both assigned at PEN, read a movement destined for PEN. Staff Profiling has no CaterLink role at all.

## Rule after the migration

Station membership alone grants nothing. A movement is readable by:

| Reader | Condition | Source of the rule |
|---|---|---|
| `service_role` | always | unchanged |
| CaterLink Management | active `caterlink_management` role in the AOC | unchanged |
| Operation Manager / Main Enforcement | active role in the AOC (oversight) | unchanged |
| Creator | `created_by = auth.uid()` (the creating Driver / officer) | unchanged |
| Origin-station operator | active `sso`/`so`/`aso`/`dse` assignment AT the origin station **and** that station's explicit `scan` capability, or active `sso`/`so`/`aso` AT the origin station and its explicit `create` capability | `caterlink_station_capabilities` via `check_station_caterlink_capability` |
| Destination-station receiver | `can_user_confirm_caterlink_receipt(receiving station)` (explicit hub/station receipt capability + active `sso`/`so`/`aso` AT that station); the receiving station is `caterlink_expected_receiving_station(hub_destination, destination_station_id)` | canonical receipt decision |

Always excluded, even with an operational role: approved-profile failures (pending / rejected / deactivated), revoked / expired / future-dated assignments, and
**Staff Profiling** (`profiling_so`, `profiling_aso`), exactly as in the scan / receipt / vendor-check capability functions. The scan *decision* function is deliberately
not referenced (an existing design assertion: no other permission derives from it); the origin branch reads the underlying capability row.

## Operation map (unchanged operations and the roles that perform them)

| Operation | Roles / capability | Decision |
|---|---|---|
| Movement list / read | table above | `transactions_read_policy` (this migration) |
| Create movement | Driver identity (create capability stations KUL - AAX / KUL - MAA) | `create_caterlink_driver_transaction_secure` |
| Origin scan / check (Part B) | PEN / JHB officers (scan capability) | `can_user_scan_caterlink` |
| Vendor action | Vendor identity; PEN / JHB officers check the delivery | `create_caterlink_vendor_delivery_secure`, `caterlink_can_check_vendor_station` |
| Destination / station verification and hub receipt | officers at stations with receipt capability (PEN, JHB, KCH, BKI, KUL) | `can_user_confirm_caterlink_receipt`, `confirm_caterlink_destination_receipt_secure` |
| Management oversight | `caterlink_management`, Operation Manager | policy + RPCs |
| Completed form / PDF, signed objects | Management, creator, hub completer, Operation Manager | `can_download_caterlink_pdf`; Storage policies follow the movement rows |

Vendor delivery rows have their own policy (`caterlink_vendor_deliveries_read`) and are not affected.

## Evidence

* Disposable-database proof (PGlite and native PostgreSQL): `verify_caterlink_visibility_runner_core.mjs` reproduces the old behaviour (profiling_aso and aso read a PEN-destined movement), runs the runner's own dry run (17 probes) and live pass, and asserts the access matrix.
* The runner's staging dry run reproduces the defect first on the hosted pre-state, then proves the matrix with real roles inside a rolled-back transaction.
* `has_station_assignment_for_transaction` is left in place but unused by any policy.
