# Staging certification fixtures (CaterLink external workflows)

All fixtures are marked `E2E` and live only on staging `ddlctzbnqewubltcavkh`. Nothing here contains a credential.

## Kept (required for repeatable certification)

| Fixture | Why it stays |
|---|---|
| whitelist company `E2EC`, vehicle `E2E1234A`, driver `E2ED001` (active, approved) | the Driver creation form and function need a usable vehicle, driver and company; the runs create them idempotently (`ensure`) |
| movement `CL-2026-000001` and its Part A / seal | the read-only fixture used for Management visibility, cross-user isolation and the profile-state reproduction (id in `%TEMP%\vecta-e2e-fixtures.json`) |
| vendor deliveries (COMPLETED, ESCALATED, CREATED, SECURITY_VERIFIED) | fixtures for completed and escalated views |
| two signature objects `e2e-probe/driver-<tag>.png` and `e2e-probe/vendor-<tag>.png` | referenced by a fixture movement and a fixture delivery (id list in `%TEMP%\vecta-storage-probe-fixtures.json`) |

## Accumulated test output (not removed)

Repeated E2E runs created further movements (`CL-2026-000002`, `-000004`, `-000005`, `-000006`) and vendor deliveries, plus the signature
objects they reference, all marked `E2E-...`. They were **not** deleted: vendor records are write-once and never deletable by design
(trigger, including for the service role) and movements are audited records; removing them would need triggers disabled, i.e. a
destructive change to audited data that nobody authorised. They are harmless, isolated by row-level security, and identifiable by the
`E2E` seal / vehicle markers. If a clean slate is ever wanted it needs its own reviewed, approved cleanup.

## Removed

All unreferenced temporary probe objects (orphan, officer and Management probes from the storage probes) were removed by the probe
script's cleanup; none remain. No Vercel bypass was created (local Next.js against staging was used).
