# Private dashboard-review preview (Vercel) -- runbook

Target: a Vercel project dedicated to VECTA preview/staging, **Preview scope only**, connected only to the approved
staging Supabase project `ddlctzbnqewubltcavkh`. Never `--prod`; never a production alias; never the production
Supabase project.

## Environment variables (names only; values never committed or printed)

| Name | Visibility | Source / rule |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | `https://ddlctzbnqewubltcavkh.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | staging publishable key |
| `NEXT_PUBLIC_APP_URL` | public | the preview URL (set after the first deploy, then redeploy once) |
| `SUPABASE_URL` | server | same staging URL |
| `SUPABASE_SECRET_KEY` | **sensitive**, server only | staging secret key; never `NEXT_PUBLIC_`; never in client assets |
| `QR_TOKEN_SECRET` | **sensitive**, server only | NEW random value generated for staging only |

Not configured (left unset): `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `WOIS_AI_*` (WOIS uses its deterministic
fallback), `RESEND_*`. Not copied to Vercel: `STAGING_DATABASE_URL`, `VECTA_DB_CA_CERT_PATH`, `VECTA_BACKUP_PASSPHRASE`,
`VECTA_*` provisioning flags, any credential file.

## Method (direct CLI preview from the clean local branch; no push)

1. `vercel login` (interactive, by the account owner), `vercel link` to the dedicated preview project.
2. Add the variables above with `vercel env add <NAME> preview` (sensitive for the two secrets), feeding values from
   the local environment through stdin so they are never printed.
3. Enable Vercel Authentication (deployment protection) for Preview so the URL is not publicly reachable.
4. `vercel deploy` (a normal preview deployment; **not** `--prod`, no promotion, no domain assignment).
5. Set `NEXT_PUBLIC_APP_URL` to the preview URL, redeploy once, and verify the final deployment.
6. Verify: HTTPS + READY; no production reference in generated assets; unauthenticated redirect to sign-in;
   representative sign-ins; scan controls only for PEN/JHB operators; desktop and mobile viewports; runtime logs.
