-- ============================================================
-- ICMS: hard-delete the mock/seed whitelist rows that had zero
-- transaction history (checked individually before running this).
-- The other mock rows (WKD 4521, WMA 7733, WTF 1289, BRU 324 and
-- drivers DRV-0091/DRV-0067/DRV-0144) are left deactivated rather than
-- deleted, since real transactions — including transactions created by
-- actual app usage, not the seed script — reference them by foreign
-- key and the FK (ON DELETE NO ACTION) correctly refuses to delete a
-- row with history. See 20260811000003 for the trigger change that
-- makes this possible.
-- ============================================================

delete from public.vehicles where vehicle_number in ('WXY 5566', 'WEX 9990');
delete from public.drivers where staff_id in ('DRV-0178', 'DRV-0203');
