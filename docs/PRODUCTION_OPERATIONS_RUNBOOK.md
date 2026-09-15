# VECTA PRODUCTION OPERATIONS RUNBOOK

This runbook provides actionable troubleshooting procedures for 24/7 aviation security and continuity operations.
**Security Notice:** No credentials or passwords are included in this runbook.

---

## 1. Authentication & Session Failures

### Symptom: User cannot sign in; redirected repeatedly to /login
- **Check:** Inspect browser network tab and query parameters on `/login` (e.g., `?error=pending_approval` or `?error=inactive`).
- **Likely Cause:** Account status in `public.profiles` or `public.users` is not `approved` or `active`, or session cookies were cleared.
- **Safe Action:** Have Admin/Management verify user account status in `/avsec/admin/users`.
- **Escalate When:** Multiple users across different stations experience sudden auth rejections simultaneously.

---

## 2. Role & Access Authorization Issues

### Symptom: User sees incorrect dashboard or "Access Restricted"
- **Check:** Query user profile `unified_role`, `role`, and `duty_post` in database / admin panel.
- **Likely Cause:** Account was assigned a different role or duty post during initial profile setup.
- **Safe Action:** Admin updates the user's role via `/avsec/admin/users`. User signs out and logs back in to refresh JWT claims.
- **Escalate When:** Admin panel updates fail to propagate or user metadata is out of sync in Supabase Auth.

---

## 3. Station / Team Assignment Issues

### Symptom: Staff member cannot see roster or flights for their current station
- **Check:** Verify `station` and `team` fields in `public.profiles`.
- **Likely Cause:** Staff member was transferred or rostered on a new team without profile record update.
- **Safe Action:** Update staff `station` / `team` in Admin panel.
- **Escalate When:** Database update succeeds but RLS still fails to match the new team after re-login.

---

## 4. Cross-Branch & `ops_group` Isolation Issues

### Symptom: Operation AVSEC staff cannot see their records, or suspected cross-branch leak
- **Check:** Verify `ops_group` on the user's profile (`operation_avsec` vs `ifc_avsec` vs `hub_avsec`) and on target records.
- **Likely Cause:** User's profile has `ops_group = NULL` or mismatch with the record's `ops_group`.
- **Safe Action:** Set correct `ops_group` on the user's profile. Never remove `ops_group` scoping from RLS policies.
- **Escalate When:** Any instance of cross-branch data exposure is observed in production (trigger P0 incident procedure).

---

## 5. Attendance & Check-In Gate Failures

### Symptom: Operational staff locked out of AVSEC modules with check-in gate prompt
- **Check:** Check if staff checked in on `/avsec/duty` for today's date (`duty_date = CURRENT_DATE`).
- **Likely Cause:** Shift staff have not completed their mandatory daily check-in or duty record has `check_in_at = NULL`.
- **Safe Action:** Direct staff to `/avsec/duty` to complete check-in with GPS verification.
- **Escalate When:** Geolocation fails persistently due to airport indoor shielding (use manual zone fallback if authorized).

---

## 6. Overtime (OT) Endorsement & Approval Failures

### Symptom: DSE cannot endorse overtime, or Management cannot approve
- **Check:** Check `status` in `public.overtime_requests`.
- **Likely Cause:**
  - OT record is already in `ENDORSED` state (DSE cannot endorse twice).
  - Management attempting to approve `PENDING` OT before DSE has endorsed it.
  - DSE belongs to different `ops_group` than the staff member.
- **Safe Action:** Verify workflow progression: `PENDING` → (DSE Endorsement) → `ENDORSED` → (Management Approval) → `APPROVED`.
- **Escalate When:** Calculated OT hours conflict with actual check-in/out timestamps in `duty_records`.

---

## 7. SEC Security Report Submissions

### Symptom: Submission button disabled or fails with error
- **Check:** Check required fields and validation checklist at top/bottom of form.
- **Likely Cause:** A mandatory field (e.g. Station, Checklist confirmation) is empty.
- **Safe Action:** Complete all required checklist fields. Note: Submitted reports cannot be edited due to DB immutability triggers.
- **Escalate When:** Database throws an unhandled constraint error on submission.

---

## 8. Shift Handover Acknowledgment

### Symptom: Incoming officer cannot acknowledge shift handover
- **Check:** Verify incoming officer has role `SO` or `DSE`, matching station, team, and `ops_group`, and is not the outgoing officer.
- **Likely Cause:** Incoming officer trying to acknowledge their own handover, or branch mismatch.
- **Safe Action:** Ensure handover is acknowledged by an incoming supervisor of the same operational branch.
- **Escalate When:** Handover remains unacknowledged past shift handover window.

---

## 9. Notification Delivery Issues

### Symptom: Bell icon badge does not update or toast does not appear
- **Check:** Check browser WebSocket connection to Supabase Realtime in Network tab.
- **Likely Cause:** Client firewall / VPN blocking WebSocket traffic to `*.supabase.co`.
- **Safe Action:** Refresh page to trigger server-side notification fetch. Notifications are persisted in DB.
- **Escalate When:** Server-side notification rows fail to write during workflow events.

---

## 10. ICMS / CaterLink Checkpoint Progression

### Symptom: Checkpoint scan displays "Out of order" error
- **Check:** Check current transaction status in `/icms/transactions/[id]`.
- **Likely Cause:** An earlier checkpoint was not completed, or transaction was escalated due to seal discrepancy.
- **Safe Action:** Review transaction timeline. For escalated transactions, follow Admin unescalate protocol.
- **Escalate When:** Vehicle is delayed at airport gate due to software state lock.

---

## 11. Signature Capture & Upload Failures

### Symptom: "Upload failed: Image exceeds 5MB limit" or signature fails to render
- **Check:** Check signature canvas data URL format and network response.
- **Likely Cause:** Canvas generated empty or oversized payload, or private bucket upload failed.
- **Safe Action:** Clear signature canvas and re-sign.
- **Escalate When:** Storage bucket permissions or RLS policies reject valid authenticated uploads.

---

## 12. Completed Form PDF Generation

### Symptom: Completed transaction PDF does not download or generates empty page
- **Check:** Check if transaction has reached `COMPLETED` status and PDF buffer was generated.
- **Likely Cause:** Missing font or template asset in serverless runtime, or transaction has incomplete part signatures.
- **Safe Action:** Ensure all required checkpoint parts have valid signatures before completing transaction.
- **Escalate When:** React-pdf crashes in production serverless function runtime.

---

## 13. Incident Photo Upload Failures

### Symptom: Photo upload rejected or fails on mobile device
- **Check:** Check file size and format (JPEG/PNG/WebP required, max 5MB).
- **Likely Cause:** Client-side image compression was bypassed or file is corrupted.
- **Safe Action:** The built-in compressor automatically downscales to ~1600px WebP. Retake photo with device camera.
- **Escalate When:** Supabase Storage `incident-photos` bucket is unresponsive.

---

## 14. Report Export (PDF / Excel) Failures

### Symptom: Export download fails with 500 error
- **Check:** Check date range and record volume requested.
- **Likely Cause:** Date range spans too many records or serverless function timeout (>15s).
- **Safe Action:** Export in smaller monthly or weekly batches.
- **Escalate When:** Single-record PDF export fails.

---

## 15. Systemic Database & Storage Connectivity

### Symptom: `/api/health` returns status `degraded`
- **Check:** Query Supabase status page and inspect database connection pooler.
- **Likely Cause:** Database connection limits reached or upstream cloud provider outage.
- **Safe Action:** Check Vercel logs and Supabase metrics dashboard for pool exhaustion.
- **Escalate When:** Downtime exceeds 5 minutes (trigger P0 severity response).
