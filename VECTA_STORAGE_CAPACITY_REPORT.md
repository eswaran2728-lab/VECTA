# VECTA LIVE PRODUCTION STORAGE & CAPACITY REPORT

Read-only analysis. No production data or architecture was modified to produce this report. Grounded in: live Supabase schema inspection (`pg_class`, `pg_stat_user_tables`, `pg_column_size()` on real rows), and direct code inspection of every storage-writing path (`lib/icms/storage.ts`, `lib/avsec/export/*`, `app/api/avsec/export/*`).

## Executive Summary

| Metric | Low | Expected | High |
|---|---:|---:|---:|
| Daily database growth | ~5.7 MB | ~7.8 MB | ~12.7 MB |
| Weekly database growth | ~40 MB | ~55 MB | ~89 MB |
| Monthly database growth | ~171 MB | ~234 MB | ~381 MB |
| Annual database growth | ~2.08 GB | ~2.85 GB | ~4.64 GB |
| Daily file-storage growth | ~19.5 MB | ~48.0 MB | ~104.8 MB |
| Monthly file-storage growth | ~585 MB | ~1.44 GB | ~3.14 GB |
| Annual file-storage growth | ~7.1 GB | ~17.5 GB | ~38.2 GB |
| **Total persistent — 1 year** | **~9.2 GB** | **~20.4 GB** | **~42.8 GB** |
| **Total persistent — 3 years** | **~27.5 GB** | **~61.1 GB** | **~128.5 GB** |
| **Total persistent — 5 years** | **~46.0 GB** | **~101.8 GB** | **~214.2 GB** |
| Records created/day | ~11,540 | ~14,070 | ~17,000 |
| Records created/year | ~4.21M | ~5.13M | ~6.20M |

**File storage (Supabase Storage: signatures, incident photos, completed-form PDFs) dominates growth, not the PostgreSQL database itself** — roughly 3.4×–8.2× the database growth rate depending on scenario. This is the single most important finding.

---

## Assumptions (stated explicitly, per instruction)

- **AVSEC active staff/day:** 180 (LOW) / 210 (EXPECTED) / 240 (HIGH) — as specified, ~3 of 4 teams on duty across a 24h day.
- **AVSEC operational/report records/active-staff/day:** flat 60, as specified (this figure is treated as **inclusive** of attendance, OT, SEC reports, handover, absence — not additive on top of them, to avoid double-counting; the mix used for weighting is stated below).
- **CaterLink drivers:** 80 total. Not all are active daily — inspected `lib/icms/workflow-vendor.ts` and `lib/icms/actions/vendor-transactions.ts`: driver activity is dispatch-triggered (a driver only generates records when assigned a delivery), so daily-active fraction is a genuine assumption, not derivable from the schema alone. Used: **50% active / 2 tx per active driver/day (LOW)**, **65% active / 3 tx per driver/day (EXPECTED)**, **85% active / 4 tx per driver/day (HIGH)** → 80 / 156 / 272 ICMS-CaterLink transactions per day.
- **Incident rate:** 5% (LOW) / 8% (EXPECTED) / 12% (HIGH) of transactions escalate to a recorded `incidents` row with photos, averaging 1.5 photos/incident — a stated assumption, not measured (too few live incident rows with photos to sample).
- **Signature file size:** signature-pad PNG (`components/icms/signature-pad.tsx`), no server- or client-side resizing found in code — used 25 KB average (realistic range 10–40 KB for a mostly-white/transparent stroke image).
- **Incident photo size:** `lib/icms/storage.ts` enforces only a hard **5 MB per-file cap**; no compression/resize step found anywhere in the upload path. Used **1.2 MB average** (realistic modern phone camera JPEG range, well under the cap).
- **Completed-form PDF size:** generated via `lib/icms/completed-form-pdf.ts` / `completed-form-pdf-vendor.ts` (react-pdf), includes embedded signature images and a QR code. Used **150 KB average**.
- **Notification volume:** current notification-producing code paths (`lib/avsec/feedback/actions.ts`, `lib/avsec/announcements/actions.ts`) are event-driven (feedback submitted, management replies), not per-user-per-day — used a conservative 0.1 / 0.3 / 0.6 notifications per active AVSEC staff/day.
- **30-day month, 365-day year**, as specified.

---

## Current VECTA Storage Architecture (as actually implemented — verified in code)

| Data type | Where it actually lives | Evidence |
|---|---|---|
| All report/attendance/transaction records | PostgreSQL rows (Supabase DB) | schema inspection |
| **Signatures** (ICMS Part A/B/C/D/Hub/REDQ, vendor parts) | **Supabase Storage**, bucket `signatures` — PNG data URL uploaded, DB stores only path + SHA-256 hash | `lib/icms/storage.ts:18-43`, called from `lib/icms/actions/transactions.ts` (6 call sites) and `vendor-transactions.ts` (3 call sites) |
| **Incident photos** | **Supabase Storage**, bucket `incident-photos`, path array stored in `incidents.photo_paths` | `lib/icms/actions/transactions.ts:1138` |
| **Completed transaction PDFs** | **Supabase Storage**, bucket `completed-forms` — generated once per completed transaction and persisted | `lib/icms/completed-form-pdf.ts:539`, `completed-form-pdf-vendor.ts:207` |
| **AVSEC SEC report PDFs** (SEC013/014/016/018/029/033) | **Not persisted.** Rendered on-demand via `@react-pdf/renderer` `renderToBuffer()` and streamed directly in the HTTP response | `app/api/avsec/export/pdf/[type]/[id]/route.tsx` — no storage upload call anywhere in this route |
| **AVSEC Excel exports** | **Not persisted.** `XLSX.write(..., {type:'buffer'})` returned directly as the response body | `app/api/avsec/export/excel/route.ts` |
| **QR codes** | **Not persisted as files.** Generated on-demand via `qrcode` npm package to a data URL, embedded directly into the PDF buffer | `app/api/avsec/export/pdf/[type]/[id]/route.tsx:33` |
| Audit trail (ICMS) | PostgreSQL, `audit_logs` table, full JSONB before/after snapshot per write | schema: `old_values jsonb, new_values jsonb` |
| Notifications | PostgreSQL, `notifications` table | schema inspection |

**No base64-in-Postgres pattern exists anywhere in this codebase** — every image/PDF asset goes to Supabase Storage object storage, not database rows. This is the correct architecture and keeps the database itself comparatively light; it also means **file storage, not database size, is the real long-term capacity driver**.

---

## Real measured row sizes (live production data, `pg_column_size()`)

| Table | Measured avg (bytes) | Live rows sampled | Notes |
|---|---:|---:|---|
| `profiles` | 166 | 31 | master data |
| `team_rosters` | 170 | 152 | master/roster data |
| `duty_records` | ~200 (182–254 range) | 288 | check-in/out, attendance |
| `report_sec014` | 269 | 2 | ASO daily report |
| `notifications` | 327 | 13 | |
| `overtime_requests` | 352 | 1 | includes endorsement/approval metadata |
| `incidents` | 339 | 6 | |
| `report_sec016` | 410 | 2 | attending-flight report |
| `shift_handovers` | 426 | 1 | includes JSON unfinished-work snapshot |
| `transactions` (ICMS) | 595 | 5 | |
| `audit_logs` (ICMS) | 1,223 | 35 | large due to full JSONB before/after snapshot per write |

Other SEC report tables (SEC013/018/029/033) currently hold 0 rows in production, so could not be measured directly; estimated at **300–450 bytes/row** by schema similarity to SEC014/016 (same staff/station/team/timestamp/remark/ops_group column pattern, ±1-2 checklist-specific columns).

**Note on index size at current scale:** raw `pg_indexes_size()` readings (e.g. `duty_records`: 184 KB indexes vs 112 KB table) look like indexes exceed data — this is an artifact of PostgreSQL's minimum-page allocation (8 KB per index) at very low row counts, **not** a real per-row ratio. It is not usable for projection and is not used below.

---

## Database Overhead Model (Section 6 — ranges, not exact)

For every table, real on-disk cost = **raw payload** + **tuple/page overhead** + **indexes** + **TOAST/MVCC/vacuum headroom**:

| Component | Estimated range | Basis |
|---|---|---|
| Raw payload | measured above | `pg_column_size()` |
| Tuple header + alignment | +24–32 bytes/row | PostgreSQL fixed per-tuple overhead (`HeapTupleHeader` ≈24B + item pointer 4B + alignment padding) |
| Indexes (PK + station/team/ops_group + date + status, typical 3–5 indexes/table) | +40–60% of table heap size | Standard OLTP btree index sizing for uuid PK + 2-4 supporting composite indexes |
| TOAST | negligible for these tables — no column exceeds ~2KB (remarks/JSONB stay well under the ~2KB TOAST threshold) except `audit_logs.old_values/new_values`, which are borderline and may TOAST occasionally | schema column widths |
| Dead tuples / MVCC / autovacuum headroom | +15–25% working headroom | UPDATE-heavy tables (`overtime_requests`, `incidents`, `notifications` — already showing dead tuples in live stats: e.g. `notifications` 13 live/16 dead, `incidents` 6 live/12 dead) generate dead tuples between autovacuum passes |

**Composite multiplier used for all DB projections below: raw payload × ~1.65** (1.0 raw + ~0.45 indexes + ~0.20 overhead/headroom, mid-range). This is a planning range, not a guarantee — actual figures will vary ±30% depending on autovacuum tuning and index design choices made later.

---

## AVSEC (Section incl. Attendance, OT, SEC Reports — the "60 records/staff/day" bucket)

Per the mandated planning figure, the 60 records/day per active staff is treated as covering (approx., for weighting only — not separately summed):

| Category | Approx. records/staff/day | Measured/estimated row size |
|---|---:|---:|
| Attendance/duty (check-in, check-out, status) | ~12 | ~200 B (`duty_records`) |
| Automatic OT (endorsement + approval trail) | ~3 | ~350 B (`overtime_requests`) |
| SEC013/014/016/018/029/033 (spread across a shift, not all 6 filed daily by every staff) | ~15 | ~270–410 B blended (~340 B) |
| Absence/leave-related | ~2 | ~300 B est. |
| Shift Handover | ~2 (outgoing + reference) | ~426 B |
| Misc operational/monitor reads that still write (acknowledgements, status touches) | ~26 | ~250 B est. |
| **Total** | **~60** | **blended weighted avg ≈ 300 B/row raw** |

**AVSEC records/day:** LOW 180×60 = **10,800** · EXPECTED 210×60 = **12,600** · HIGH 240×60 = **14,400** (HIGH also assumes a heavier average payload, ~420 B, reflecting "larger report payloads" per the HIGH scenario definition — LOW/EXPECTED use ~270 B and ~300 B respectively).

**AVSEC DB bytes/day** (raw × 1.65 overhead multiplier):
- LOW: 10,800 × 270 B × 1.65 ≈ **4.81 MB/day**
- EXPECTED: 12,600 × 300 B × 1.65 ≈ **6.24 MB/day**
- HIGH: 14,400 × 420 B × 1.65 ≈ **9.98 MB/day**

---

## CaterLink / ICMS

Per transaction (Part A → dispatch → checkpoint(s) → completion), inspected `lib/icms/actions/transactions.ts` and `workflow.ts`:

- 1 `transactions` row (~600 B measured)
- ~3 child "part" rows on average (`part_a`/`part_b`/`part_c`/`part_d`/`part_hub`/`part_redq` — route-dependent, not every part fires for every transaction) at ~250 B est. each ≈ 750 B
- ~5 `audit_logs` rows across the lifecycle (create, dispatch, each checkpoint, complete) at 1,223 B measured ≈ 6,115 B — **this is the single largest per-transaction DB cost**, driven by full JSONB before/after snapshots

**DB bytes/transaction (raw):** ~600 + 750 + 6,115 ≈ **7,465 B**, × 1.65 overhead ≈ **12.3 KB/transaction**

**Transactions/day:** LOW 80 · EXPECTED 156 · HIGH 272 (see Assumptions)

**CaterLink/ICMS DB bytes/day:**
- LOW: 80 × 12.3 KB ≈ **0.98 MB/day**
- EXPECTED: 156 × 12.3 KB ≈ **1.92 MB/day**
- HIGH: 272 × 12.3 KB ≈ **3.35 MB/day**

**File storage (Supabase Storage, not DB):**

| Asset | Avg size | Qty/transaction | LOW (80 tx) | EXPECTED (156 tx) | HIGH (272 tx) |
|---|---:|---:|---:|---:|---:|
| Signatures | 25 KB | ~2/transaction | 4.0 MB/day | 7.8 MB/day | 13.6 MB/day |
| Completed-form PDF | 150 KB | ~0.7-0.8/transaction (not all complete same day) | 8.4 MB/day | 17.6 MB/day | 32.7 MB/day |
| Incident photos | 1.2 MB | 5%/8%/12% incident rate × 1.5 photos | 7.2 MB/day | 22.8 MB/day | 58.8 MB/day |
| **Subtotal** | | | **19.6 MB/day** | **48.2 MB/day** | **105.1 MB/day** |

**Incident photos are the dominant single file-storage driver at HIGH scenario** — a direct consequence of no client-side compression existing in the current upload path (see Optimization Recommendations).

---

## Notifications

Measured row size: 327 B. Event-driven, not per-user-per-day (see Assumptions).

- LOW: 180 × 0.1 = 18/day × 327 B × 1.65 ≈ **9.7 KB/day** — negligible
- EXPECTED: 210 × 0.3 = 63/day ≈ **34 KB/day**
- HIGH: 240 × 0.6 = 144/day ≈ **78 KB/day**

Confirmed: **notifications are not a meaningful storage driver** at any realistic volume.

---

## LOW / EXPECTED / HIGH — Combined Daily Totals

| Category | LOW | EXPECTED | HIGH |
|---|---:|---:|---:|
| AVSEC DB | 4.81 MB | 6.24 MB | 9.98 MB |
| CaterLink/ICMS DB | 0.98 MB | 1.92 MB | 3.35 MB |
| Notifications DB | ~0.01 MB | ~0.03 MB | ~0.08 MB |
| **Database total/day** | **5.80 MB** | **8.19 MB** | **13.41 MB** |
| CaterLink/ICMS file storage | 19.6 MB | 48.2 MB | 105.1 MB |
| **File storage total/day** | **19.6 MB** | **48.2 MB** | **105.1 MB** |
| **Grand total/day** | **25.4 MB** | **56.4 MB** | **118.5 MB** |

*(Executive Summary figures above are rounded slightly differently due to independent rounding at each stage; treat both as the same order-of-magnitude estimate — this is a planning range, not a precise forecast.)*

---

## Time-Period Projections

### Database only

| Period | Low | Expected | High |
|---|---:|---:|---:|
| Per Hour | 0.24 MB | 0.34 MB | 0.56 MB |
| Per Day | 5.8 MB | 8.2 MB | 13.4 MB |
| Per Week | 40.6 MB | 57.3 MB | 93.9 MB |
| Per Month (30d) | 174 MB | 246 MB | 402 MB |
| 3 Months | 522 MB | 737 MB | 1.21 GB |
| 6 Months | 1.02 GB | 1.44 GB | 2.35 GB |
| 1 Year | 2.03 GB | 2.87 GB | 4.70 GB |
| 2 Years | 4.06 GB | 5.74 GB | 9.40 GB |
| 3 Years | 6.09 GB | 8.61 GB | 14.1 GB |
| 5 Years | 10.2 GB | 14.3 GB | 23.5 GB |

### File storage only (Supabase Storage)

| Period | Low | Expected | High |
|---|---:|---:|---:|
| Per Hour | 0.82 MB | 2.0 MB | 4.4 MB |
| Per Day | 19.6 MB | 48.2 MB | 105.1 MB |
| Per Week | 137 MB | 337 MB | 736 MB |
| Per Month (30d) | 588 MB | 1.45 GB | 3.15 GB |
| 3 Months | 1.72 GB | 4.23 GB | 9.22 GB |
| 6 Months | 3.44 GB | 8.47 GB | 18.4 GB |
| 1 Year | 6.85 GB | 16.9 GB | 36.8 GB |
| 2 Years | 13.7 GB | 33.7 GB | 73.6 GB |
| 3 Years | 20.6 GB | 50.6 GB | 110.5 GB |
| 5 Years | 34.3 GB | 84.3 GB | 184.1 GB |

### Total persistent storage (DB + files)

| Period | Low | Expected | High |
|---|---:|---:|---:|
| Per Hour | 1.06 MB | 2.35 MB | 4.94 MB |
| Per Day | 25.4 MB | 56.4 MB | 118.5 MB |
| Per Week | 178 MB | 395 MB | 830 MB |
| Per Month | 762 MB | 1.69 GB | 3.55 GB |
| 3 Months | 2.24 GB | 4.97 GB | 10.4 GB |
| 6 Months | 4.46 GB | 9.91 GB | 20.8 GB |
| **1 Year** | **8.88 GB** | **19.7 GB** | **41.5 GB** |
| **2 Years** | **17.8 GB** | **39.5 GB** | **83.0 GB** |
| **3 Years** | **26.6 GB** | **59.2 GB** | **124.5 GB** |
| **5 Years** | **44.4 GB** | **98.7 GB** | **207.6 GB** |

### Bandwidth (not persistent storage — separate)

Dominated by: attachment/signature uploads (already counted as storage writes, but also consume upload bandwidth once), completed-form PDF downloads, on-demand SEC-report PDF/Excel generation-and-download (zero storage, full bandwidth each time), and QR page loads.

| Period | Low | Expected | High |
|---|---:|---:|---:|
| Per Day | ~40–60 MB | ~100–150 MB | ~220–320 MB |
| Per Month | ~1.2–1.8 GB | ~3.0–4.5 GB | ~6.6–9.6 GB |
| Per Year | ~15–22 GB | ~36–54 GB | ~80–115 GB |

This is a coarse estimate (upload bytes ≈ storage growth, plus an assumed 1–2 re-downloads per generated PDF/Excel/signed-URL view on average) — genuinely harder to pin down than storage without production traffic logs, and is flagged as lower-confidence than the storage figures above.

---

## Row Growth

| Period | AVSEC Report Rows | Attendance/Duty* | OT* | ICMS/CaterLink | Notifications | Audit Logs | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Day (EXPECTED) | *(within AVSEC 12,600)* | *(within)* | *(within)* | 624 | 63 | 780 | **14,067** |
| Week | 88,200 | — | — | 4,368 | 441 | 5,460 | 98,469 |
| Month (30d) | 378,000 | — | — | 18,720 | 1,890 | 23,400 | 421,050 (**~1.26M rows/quarter**) |
| Year | 4,599,000 | — | — | 227,760 | 22,995 | 284,700 | **5.13M** |
| 3 Years | 13.80M | — | — | 683,280 | 68,985 | 854,100 | **15.4M** |
| 5 Years | 23.00M | — | — | 1.14M | 114,975 | 1.42M | **25.7M** |

*Attendance/duty and OT are already inside the "AVSEC Report Rows" column per the stated no-double-count rule — shown in the category breakdown above, not summed separately here.

LOW scenario totals: ~11,538 rows/day → ~4.21M/year → ~21.1M/5yr.
HIGH scenario totals: ~16,992 rows/day → ~6.20M/year → ~31.0M/5yr.

---

## Row-Count Milestones — which tables get there first

The 10,800–14,400/day AVSEC figure is **spread across ~10+ distinct tables** (6 SEC report tables + `duty_records` + `overtime_requests` + `absence_notices` + `shift_handovers`), so no single AVSEC table reaches these milestones from AVSEC volume alone anywhere near as fast as a naive single-table read of the total would suggest. Per-table estimate (EXPECTED scenario):

| Table | Est. rows/day | 100K rows | 1M rows | 5M rows | 10M rows |
|---|---:|---|---|---|---|
| `audit_logs` (ICMS) | ~780 | ~4.3 months | ~3.5 years | ~17.6 years | ~35 years |
| `transactions` (ICMS) | ~156 | ~1.8 years | ~17.6 years | — | — |
| `duty_records` (attendance, ~2/staff/day) | ~420 | ~8 months | ~6.5 years | ~32.6 years | — |
| Any single SEC report table (e.g. `report_sec014`, ~2.5/staff/day) | ~525 | ~6.4 months | ~5.2 years | ~26 years | — |
| `notifications` | ~63 | ~4.3 years | ~43.5 years | — | — |

**`audit_logs` is the fastest-growing table by a wide margin** — it is the only table where a 5-million-row milestone is realistically reached within the planning horizon of this report (within ~17–18 years at current assumed volume; if ICMS transaction volume itself grows 3-5× beyond the HIGH scenario in later years, this compresses proportionally). No table is projected to approach 100 million rows within any horizon considered here at the stated assumptions.

**When to act (not "implement now"):**
- **Composite indexes** on `(station, team, ops_group, submitted_at)` / `(transaction_id, performed_at)` — already present per the RLS/query patterns audited earlier this session; revisit if query latency degrades, not on a row-count trigger alone.
- **Partitioning** `audit_logs` by month/quarter — worth planning once it clears ~2–3M rows (roughly year 6-8 at current pace), not before; partitioning too early adds operational complexity for no benefit.
- **Archiving/retention** — see Retention Strategy below; this is a policy decision independent of row count, driven by aviation/security compliance requirements.
- **Materialized summaries** for dashboards — worth it once the `audit_logs`/`transactions` join patterns in dashboard queries show up as slow in `pg_stat_statements`, not preemptively.
- **Cold storage / object lifecycle rules** on Supabase Storage buckets (older incident photos, completed-form PDFs) — worth configuring once file storage crosses ~50 GB, well before the database itself needs partitioning, since file storage grows 3-8× faster per this report.

---

## Supabase Capacity

Inspected the live project (`vecta-prod`, ref `zsxneokqulktgnccxgkz`, region `ap-northeast-1`, Postgres 17.6). The Supabase Management API available in this session returns project identity/region/database-version metadata only — **it does not expose the billing plan tier or its storage/bandwidth limits**, and no plan configuration file exists in this repository.

**PLAN LIMIT NOT VERIFIED.**

What VECTA would need to be provisioned for, from this report, without inventing Supabase's actual tier limits:

| Horizon | Database | File Storage |
|---|---:|---:|
| 1 year | ~3–5 GB | ~7–37 GB |
| 3 years | ~9–14 GB | ~21–111 GB |
| 5 years | ~14–24 GB | ~34–184 GB |

Compare these against whatever plan is actually active on the Supabase dashboard (Free/Pro/Team/Enterprise tiers each carry different DB and Storage caps) — this report supplies the requirement, not the limit.

---

## Backup Storage

Not billed/counted as application storage unless the hosting plan's own backup retention does so (Supabase's own managed backups are plan-dependent and were not verifiable here — see above). Qualitative implications as the DB grows:

| DB size | Backup implication |
|---|---|
| 10 GB | Full backup/restore is fast (minutes); negligible operational concern |
| 25 GB | Still comfortably fast; point-in-time recovery windows should be reviewed |
| 50 GB | Restore time becomes a real recovery-time-objective (RTO) consideration for an operational aviation system — worth a documented RTO/RPO target at this size |
| 100 GB | Warrants an explicit backup/restore drill and retention policy review, not just reliance on default managed backups |

At the EXPECTED scenario, the database alone does not reach 50 GB within the 5-year horizon modeled here (projected ~14.3 GB at 5 years) — this is a forward-looking note, not an imminent concern.

---

## Retention Strategy

**Do not automatically delete security records.** Recommended tiering:

| Tier | Contents | Rationale |
|---|---|---|
| **HOT** | Current + prior ~90 days of duty/attendance/OT/SEC reports, active ICMS transactions, unread notifications | Actively queried by dashboards, monitors, approval queues |
| **WARM** | 90 days – 2 years: submitted SEC reports, completed ICMS transactions, resolved incidents, read notifications | Still searchable (report lookup, audit trail), lower query frequency |
| **ARCHIVE** | 2+ years: SEC reports (SEC013/014/016/018/029/033 already immutable-by-trigger once submitted), completed-form PDFs, audit logs, incident records with photos | Required for aviation/security compliance and audit; move to cheaper storage class, do not delete |

**Should NOT be automatically deleted without management/regulatory approval:** every submitted SEC report row (already enforced immutable at the DB trigger level — confirmed in this audit's prior sessions), `audit_logs`, `incidents` and their photos, completed-form PDFs, signature files (chain-of-custody evidence for catering security). Notifications and non-security operational chatter are reasonable candidates for a shorter, policy-defined retention window if ever needed — SEC/security/audit data is not.

---

## 24/7 Live Operation

| | Average | Busy period (peak shift overlap) | Peak (shift change / incident surge) |
|---|---:|---:|---:|
| Writes/hour (EXPECTED) | ~586 rows | ~1,200–1,800 rows | ~3,000+ rows |
| DB growth/hour | ~0.34 MB | ~0.7–1.0 MB | ~1.5–2 MB |
| Concurrent active users | 15–30 | 60–100 | 150+ (shift handover window, all 3 teams briefly overlapping) |
| Report submissions/minute | <1 | 2–4 | 8–12 (end-of-shift report filing surge) |
| CaterLink transactions/minute | <1 | 1–3 | 5–8 (peak catering dispatch window) |

Airport/aviation operations are inherently peaked around shift changes (typically 3 changeovers/day for a 3-shift roster) and flight-schedule-driven catering windows — activity is **not evenly distributed**; the "busy period" and "peak" columns reflect this rather than a flat 24-hour average.

---

## Management / Enforcement

Correctly scoped as primarily **read load**, not storage drivers — confirmed in code: dashboard/report-search/monitor pages (`lib/avsec/dashboard/queries.ts`, `lib/avsec/reports/queries.ts`) are `SELECT`-only. Storage impact from this role group is limited to:
- Approval/endorsement writes (already counted within the OT/attendance figures above — `overtime_requests` approval fields are updates to the existing row, not new rows)
- Notifications generated to/from them (already counted above, negligible)
- Exports, **only if a user chooses to persist one** — the export endpoints themselves generate on-demand, zero-persistence PDFs/Excel files (see Architecture table); a management user downloading a report does not grow the database or Storage bucket at all.

Ordinary page views/searches are correctly excluded from this analysis as read/compute/bandwidth load, not storage.

---

## Top 5 Storage Consumers — Ranked

1. **Incident photos** (Supabase Storage) — largest single consumer at HIGH scenario (~58.8 MB/day, ~21.5 GB/year). Why: no client-side compression/resize exists anywhere in the upload path (`lib/icms/storage.ts` only enforces a 5 MB hard cap), so real camera-resolution JPEGs (assumed ~1.2 MB avg) are stored at full size.
2. **Completed-form PDFs** (Supabase Storage) — second largest (~17.6–32.7 MB/day mid/high). Every completed ICMS transaction persists one, and this is by design (compliance record), not incidental.
3. **Signatures** (Supabase Storage) — smaller per-file (~25 KB) but high frequency (~2/transaction) — meaningful (~7.8–13.6 MB/day mid/high) but not dominant.
4. **`audit_logs`** (PostgreSQL) — the largest *database* table by both row size (1,223 B measured, ~4-6× any other table) and growth rate; fastest table to reach multi-million-row milestones, though still years away.
5. **AVSEC SEC report + attendance rows** (PostgreSQL) — highest row *count* (10,800–14,400/day) but smallest per-row payload (~270–420 B), so despite dominating row growth it is the DB's 5th-largest byte contributor, well behind every file-storage category.

**Confirmed: attachments/photos are indeed much larger than normal PostgreSQL rows**, as anticipated — file storage is projected at **3.4×–8.2× the database's growth rate** across all three scenarios.

---

## Storage Optimization Recommendations (recommendations only — not implemented)

- **Incident photos:** add client-side resize/compression before upload (e.g. cap to ~1600px longest edge, JPEG quality ~75) — this alone would likely cut the largest storage consumer by 60-80% with no functional loss for evidentiary photos.
- **Signatures:** already small; no action needed.
- **Completed-form PDFs:** already reasonably sized; consider a lifecycle rule to move PDFs older than the WARM-tier boundary to Supabase Storage's cheaper/archive-class storage once that becomes available in-plan.
- **`audit_logs`:** consider trimming `old_values`/`new_values` JSONB to only the fields that actually changed (a diff) rather than full before/after snapshots, once this table's growth rate becomes a measured concern — not urgent today.
- **Composite indexes:** current RLS-driven `(station, team, ops_group, ...)` indexes are appropriate; revisit only if `pg_stat_statements` shows slow queries.
- **Partitioning:** plan for `audit_logs` monthly/quarterly partitioning once it clears a few million rows — premature before that.
- **Retention/archiving:** implement the HOT/WARM/ARCHIVE tiering above as a policy, coordinated with management/compliance sign-off, not as an automatic deletion job.
- **File-size limits:** the existing 5 MB/file cap is reasonable; consider lowering it to ~2 MB in tandem with adding client-side compression.
- **Thumbnailing:** if incident photos are ever displayed in list/grid views, generate and store a small thumbnail alongside the full photo to avoid pulling full-resolution images for browsing.

---

## Recommended Production Capacity (today)

| | Target |
|---|---|
| Database target capacity | Provision for **~10–15 GB** today (covers the HIGH scenario out to ~3 years with headroom, and the EXPECTED scenario out to 5+ years) |
| File storage target capacity | Provision for **~50–100 GB** today (covers EXPECTED scenario to ~3 years, HIGH scenario to ~1.5-2 years) — **this is the tier that needs the most active headroom planning**, not the database |
| Bandwidth target | Plan for **~10-15 GB/month** at EXPECTED, scaling toward ~30 GB/month at HIGH |
| Backup requirement | Whatever the active Supabase plan provides by default at this size is very likely sufficient today; revisit explicitly once DB crosses ~50 GB (not projected within 5 years at EXPECTED) |

---

## Recommended Headroom

**Recommend provisioning at 2× the EXPECTED 3-year projection** for both database and file storage:
- Database: EXPECTED 3-year ≈ 8.6 GB → provision for **~17-20 GB**
- File storage: EXPECTED 3-year ≈ 50.6 GB → provision for **~100-120 GB**

**Why 2×, not 1.5× or 3×:** 1.5× is too tight given the genuine uncertainty in the two least-certain inputs in this whole model — CaterLink daily-active-driver behavior and incident-photo compression (both are *assumptions*, not measurements, because production traffic/photo-handling data doesn't exist yet). 3× would be over-provisioning for a system whose real usage pattern will become measurable within the first few months of live operation — at that point, re-run this analysis against real `pg_stat_user_tables` and Storage bucket metrics rather than continuing to plan from assumptions. 2× balances that uncertainty without materially overpaying today.

---

## Final Verdict: **CAPACITY SAFE**

Both PostgreSQL database growth and Supabase Storage growth are modest in absolute terms across all three scenarios over a 5-year horizon (database: 10–24 GB; file storage: 34–184 GB) relative to what modern managed Postgres/object-storage platforms comfortably handle. No table is projected to approach a scale (100M+ rows, 100+ GB) that would force premature architectural intervention. The one genuine watch-item is **incident-photo storage growth at the HIGH scenario**, driven by the absence of client-side image compression — this is a low-effort optimization opportunity, not a blocker, and is flagged above rather than treated as a capacity risk. Supabase's actual plan limits were not verifiable in this session and should be checked directly against the recommended capacity targets before declaring the plan itself sufficient.

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
