-- Adds a distinct "deactivated" status for former staff (e.g. resigned) — separate from
-- "rejected" (a declined signup request), so the wording an ex-staff member sees on
-- pending-approval is accurate, and separate from deleting them outright so their
-- historical report submissions stay intact for audit purposes.
alter type profile_status add value 'deactivated';
