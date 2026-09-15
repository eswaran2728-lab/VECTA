# VECTA DEPLOYMENT SAFETY & RELEASE PIPELINE

## 1. Release Flow Pipeline
To maintain continuous operations without operational disruption, code changes must pass the following staged sequence:

```text
CODE
  ↓
TYPECHECK (npx tsc --noEmit -p .)
  ↓
LINT (npm run lint - 0 errors required)
  ↓
UNIT & REGRESSION TESTS (npm test - 100% pass)
  ↓
OPTIMIZED PRODUCTION BUILD (npm run build)
  ↓
PREVIEW DEPLOYMENT & SMOKE TEST
  ↓
DATABASE MIGRATION PRE-CHECK & APPLY
  ↓
PRODUCTION DEPLOYMENT (Vercel)
  ↓
HEALTH CHECK VERIFICATION (/api/health)
  ↓
LIVE SMOKE TEST & MONITORING
```

## 2. Gate Criteria for Production Release
- **TypeScript:** Clean compilation with zero type errors.
- **Linter:** Zero lint errors.
- **Unit Tests:** All automated tests must pass.
- **RLS Regression:** `tests/rls-isolation-regression.test.mts` must pass without exception.
- **Security Headers:** HSTS, CSP, X-Frame-Options, X-Content-Type-Options verified in production headers.
- **Secrets:** No API keys, service role keys, or database credentials in client bundles or git commits.

## 3. Immediate Rollback Protocol
If any critical failure occurs following a production deployment:
1. Revert to previous stable deployment in Vercel Dashboard (Instant Rollback < 60 seconds).
2. If database migration accompanied the release, evaluate rollback script per `MIGRATION_SAFETY.md`.
3. Notify Operations and log incident in accordance with `SECURITY_INCIDENT_RUNBOOK.md`.
