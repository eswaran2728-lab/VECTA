# VECTA SECURITY INCIDENT RESPONSE RUNBOOK

## 1. Scope & Objective
This runbook defines the mandatory response protocol for security events impacting VECTA, including suspected RLS failures, credential leakage, cross-branch data exposure, unauthorized account creation, or tampering attempts.

## 2. 8-Stage Incident Response Lifecycle

```text
1. CONTAIN → 2. PRESERVE EVIDENCE → 3. IDENTIFY SCOPE → 4. REVOKE/ROTATE → 5. FIX → 6. VERIFY → 7. DOCUMENT → 8. RECOVER
```

---

### Stage 1: Containment
- **Goal:** Stop active exploitation or data leakage immediately.
- **Actions:**
  - If a specific user account is compromised: In Supabase Auth, immediately disable the user or ban the UID (`status = 'suspended'`).
  - If cross-branch leakage or RLS policy defect is discovered: Deploy an immediate hotfix or route-level restriction.
  - If service keys are leaked: Revoke access or restrict origin domains immediately.

---

### Stage 2: Evidence Preservation
- **DO NOT DELETE LOGS OR MUTATED RECORDS AUTOMATICALLY.**
- Export relevant rows from `public.audit_logs` capturing `old_values` and `new_values`.
- Capture Vercel access logs, request headers, IP addresses, and timestamps.
- Save SHA-256 hashes of any disputed file uploads or signatures.

---

### Stage 3: Scope Identification
- Determine the blast radius:
  - Which operational branches were affected (`operation_avsec`, `ifc_avsec`, `hub_avsec`, `caterlink`)?
  - Which stations and teams?
  - Were immutable security reports (`report_sec013-033`) read or targeted?
  - Were file storage objects (`signatures`, `incident-photos`) downloaded?

---

### Stage 4: Revocation & Secret Rotation
- If `SUPABASE_SERVICE_ROLE_KEY` or database credentials were exposed:
  1. Generate new service role key in Supabase Dashboard.
  2. Update environment variables in Vercel Production (`.env`).
  3. Redeploy application to activate new credentials.
  4. Revoke the old key after confirming zero active traffic on the previous key.
- If user credentials were leaked: Force password reset and terminate all active sessions.

---

### Stage 5: Remediation & Patching
- Implement root-cause fix in codebase or database migration.
- Ensure all RLS policies maintain `(station + team + ops_group)` isolation.
- Add regression test in `tests/rls-isolation-regression.test.mts` covering the exact vulnerability pattern.

---

### Stage 6: Live Verification
- Run full test suite: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
- Verify fix in production with safe test identities.
- Confirm `/api/health` reports status `ok`.

---

### Stage 7: Incident Documentation & Post-Mortem
- Document:
  - Incident Severity (P0, P1, P2).
  - Root Cause Analysis (RCA).
  - Exact timeline (Detection, Containment, Resolution).
  - Scope of compromised data (if any).
  - Corrective actions implemented.

---

### Stage 8: Recovery & Normal Operations Resumption
- Restore normal user access and operational workflows.
- Continue enhanced observability monitoring for 48 hours following incident closure.
