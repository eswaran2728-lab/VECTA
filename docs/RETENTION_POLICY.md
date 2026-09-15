# VECTA DATA RETENTION & ARCHIVING POLICY

## 1. Regulatory Context & Core Principle
VECTA supports aviation security enforcement, chain of custody, and regulatory compliance.
**Core Principle:** Security reports, audit logs, chain-of-custody signatures, and incident evidence MUST NOT be deleted automatically.

## 2. Proposed Tiering Structure

| Data Tier | Age Threshold | Storage Location | Operational Accessibility |
|---|---|---|---|
| **HOT** | 0 – 90 Days | Primary Postgres DB & Active Supabase Storage | Real-time queries, dashboards, active monitors, instant download |
| **WARM** | 91 Days – 2 Years | Primary Postgres DB & Compressed Storage | Searchable via Report Lookup & Audit screens; lower query frequency |
| **ARCHIVE** | 2+ Years | Cold / Partitioned DB & Cold Object Storage | Regulatory audit retrieval only; read-only compliance storage |

---

## 3. Data Category Retention & Management Rules

### A. Submitted Security Reports (SEC013, SEC014, SEC016, SEC018, SEC029, SEC033)
- **Status:** Immutable once submitted (enforced by DB trigger).
- **HOT Tier (0–90d):** Full query access by station/team/ops_group.
- **WARM Tier (91d–2y):** Accessible via historical search `/avsec/reports/lookup`.
- **ARCHIVE Tier (2y+):** Retained indefinitely or per aviation authority mandate.
- **Automated Deletion:** ❌ STRICTLY PROHIBITED.
- **Decision:** `COMPLIANCE / MANAGEMENT DECISION REQUIRED` for ultimate statutory duration (e.g. 5 vs 7 years).

### B. Duty & Attendance Records (`duty_records`)
- **HOT Tier (0–90d):** Daily attendance and duty monitoring.
- **WARM Tier (91d–2y):** Historical payroll / shift verification.
- **ARCHIVE Tier (2y+):** Archived for labor / audit compliance.
- **Automated Deletion:** ❌ PROHIBITED without management approval.

### C. Overtime Requests (`overtime_requests`)
- **HOT Tier (0–90d):** Endorsement & approval queue processing.
- **WARM Tier (91d–2y):** Historical export & finance reconciliation.
- **ARCHIVE Tier (2y+):** Retained in audit archive.

### D. ICMS Transactions & Checkpoint Records (`transactions`, `part_a-d`)
- **HOT Tier (0–90d):** Active dispatch and airport gate verification.
- **WARM Tier (91d–2y):** Chain of custody lookup.
- **ARCHIVE Tier (2y+):** Retained for catering security compliance.

### E. Signatures & Completed-Form PDFs (Supabase Storage: `signatures`, `completed-forms`)
- **HOT Tier (0–90d):** Readily served via short-lived signed URLs (1hr TTL).
- **WARM / ARCHIVE Tier:** Preserved in object storage; never purged while parent transaction exists.

### F. Incident Records & Evidence Photos (`incidents`, `incident-photos`)
- **Status:** High legal and security sensitivity.
- **Client-Side Optimization:** Images compressed to ~1600px WebP prior to upload.
- **Retention:** Retained for the full duration of any investigation or regulatory inquiry.
- **Automated Deletion:** ❌ STRICTLY PROHIBITED.

### G. Audit Logs (`audit_logs`)
- **Database Watch Item:** Fastest growing table (~1,223 bytes/row due to JSONB snapshots).
- **HOT Tier (0–90d):** Immediate investigation of transaction state changes.
- **WARM Tier (91d–2y):** Available for supervisory review in `/icms/admin/audit`.
- **Archiving Recommendation:** Plan for table partitioning (e.g., quarterly tables) once row count exceeds 2,000,000 rows.

### H. Operational Notifications (`notifications`)
- **HOT Tier (0–30d):** Active bell icon delivery and unread notifications.
- **WARM Tier (31–90d):** Read notifications history.
- **Retention / Purge:** Candidate for automated cleanup of read notifications older than 180 days (`COMPLIANCE / MANAGEMENT DECISION REQUIRED`).
