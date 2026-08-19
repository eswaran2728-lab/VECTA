-- ============================================================
-- CSCS v2 - PHASE 3: Signed QR tokens
-- Token format: <transactionId>.<expiryUnix>.<HMAC-SHA256 base64url>
-- Signed and verified server-side (src/lib/qr-token.ts) with
-- QR_TOKEN_SECRET; the column stores the token issued at creation.
-- Tokens for existing open transactions are backfilled by the app
-- the next time their QR pass is rendered (tokens are stateless).
-- ============================================================

alter table public.transactions add column if not exists qr_token text;
