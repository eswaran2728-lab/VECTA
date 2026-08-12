-- ============================================================
-- Hotfix: enforcement@icms.local (created in 20260812000002) could not
-- sign in — "Invalid email or password" despite a correct password
-- hash. Root cause: confirmation_token, recovery_token,
-- email_change_token_new and email_change were NULL (no explicit
-- value given on insert, and those four columns have no default),
-- whereas a real GoTrue-created row always has empty strings there.
-- GoTrue's Go code scans these into plain (non-nullable) strings, so a
-- NULL breaks the internal user lookup during authentication. Fixed by
-- setting them to '' to match every other working account's row shape.
-- ============================================================

update auth.users
set confirmation_token = '',
    recovery_token = '',
    email_change_token_new = '',
    email_change = ''
where email = 'enforcement@icms.local';
