-- ============================================================
-- ICMS: replace demo/seed whitelist data with the real Inflight
-- Catering (IFC) roster, sourced from the airline's official
-- Hi-Lift/Bonded Truck and driver staff-list PDFs (2026-08-11).
--
-- All 6 pre-existing seed vehicles (WKD 4521, WMA 7733, etc.) and 5
-- of the 6 seed drivers are deactivated, never deleted, per this
-- table's existing "deactivated, never deleted" rule. One existing
-- driver row (staff_id 1047580, "ESWARAN") already used the real
-- 7-digit staff ID format rather than the DRV-XXXX seed pattern and
-- is left untouched — it isn't seed data.
--
-- vehicle_number is the plate observed at checkpoints; the source
-- PDF's separate "HI-LIFT / BONDED NO." fleet code (e.g. "IFS 12",
-- "CAT 07") is stored in truck_registration_number instead, since
-- that's the internal identifier, not what's painted on the vehicle.
-- Two units explicitly marked "GROUNDED" in the source are inserted
-- inactive (BMH 4533 / IFS 10, BMH 4536 / IFS 11).
-- ============================================================

-- Deactivate seed/demo whitelist rows (soft, never deleted).
update public.vehicles set is_active = false where is_active = true;
update public.drivers set is_active = false where staff_id in (
  'DRV-0203', 'DRV-0178', 'DRV-0091', 'DRV-0067', 'DRV-0144'
);

-- Real Inflight Catering (IFC) vehicle fleet: Hi-Lift + Bonded Truck units,
-- KUL + outstation bases. vehicle_number is the plate (checked at posts);
-- truck_registration_number is the internal fleet code / descriptor.
insert into public.vehicles (vehicle_number, catering_company_id, truck_type, truck_registration_number, is_active) values
  ('BPU 6107', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 12', true),
  ('BPV 2679', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 13', true),
  ('BPS 1924', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 14', true),
  ('BPX 1925', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 15', true),
  ('BPX 1926', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 16', true),
  ('BRX 7144', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 17', true),
  ('BRX 7138', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 18', true),
  ('BRX 7108', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 19', true),
  ('BRX 7087', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 20', true),
  ('BRX 7840', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 21', true),
  ('BSD 842', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 07', true),
  ('BSE 9903', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 08', true),
  ('BSE 7620', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 09', true),
  ('BSE 7220', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 10', true),
  ('BSE 2032', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 11', true),
  ('BSD 9589', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 12', true),
  ('BSE 2058', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 13', true),
  ('BSE 2460', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 14', true),
  ('BNU 3516', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 01', true),
  ('BNU 4274', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 03', true),
  ('BKE 1054', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 04', true),
  ('BKC 7093', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 05', true),
  ('BNU 3526', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 02', true),
  ('BNU 4216', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 04', true),
  ('BNU 4654', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 05', true),
  ('BMH 4538', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 09', true),
  ('BNU 3520', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'CAT 06', true),
  ('BMH 4533', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 10', false),
  ('BMH 4536', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Hi-Lift', 'IFS 11', false),
  ('WJE 2685', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Bonded Truck', 'LOGISTIC TRUCK (RED)', true),
  ('WKX 2955', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Bonded Truck', 'LOGISTIC TRUCK (GREEN)', true),
  ('BRF 2461', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Bonded Truck', 'RUNNER BONDED TRUCK (RED)', true),
  ('BRP 4251', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', 'Bonded Truck', 'RUNNER BONDED TRUCK (GREEN)', true);

-- Real Inflight Catering (IFC) in-flight driver roster.
insert into public.drivers (name, staff_id, catering_company_id, is_active) values
  ('MUHAIZA BIN MUHAMAD DERAHIM', '1001099', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('SARIFUDDIN BIN KASIM', '1001101', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('AMRAN BIN NAYAN', '1002918', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ZAINAL ARIFFIN BIN SUKIAN', '1003212', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ARJUN A/L VEERAPPAN', '1005213', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD KHAIRUDDIN BIN MAT JALI', '1002344', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD ISWAN BIN MOHD ROSMAN', '1006325', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('GHAZALIE BIN ROSLAN', '1007643', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ROMIE BIN SAMSUDIN', '1007950', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('SHARIL BIN SOPIAN', '1009060', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('KENNY DAS A/L ANTHONYSAMY', '1019609', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('INDIRAN A/L SHANMUGAM', '1032804', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD FAUZI BIN BAHARIM', '1032807', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMED HANEFF BIN MOHAMED HAFAZ', '1003503', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ASRI BIN HASHIM', '1032789', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD HARIS BIN PARDI', '1032810', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMAD FAZLI BIN ISMAIL', '1033040', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUIZZUDIN BIN MOHD YUSOF', '1033041', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD SHAHRUL BIN JUSOH', '1033059', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMMAD BIN MANGUN', '1035893', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD RIDUWAN BIN ALI', '1037664', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMAAD MARZUKI BIN ISHAK', '1037686', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD SYAFIQ BIN MOHD ROZI', '1037687', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('NILAMEGAM A/L GUNARATHNAM', '1037950', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD FAIZAL BIN IBRAHIM', '1038208', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('JANARDHANAN A/L GANESON', '1038211', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD AKMAL BIN ALI', '1038233', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD HISHAM BIN YAACOB', '1038389', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD TAWFIQ BIN NOR HASHIM', '1005681', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('LUQMAN HAKIM BIN ABU BAKAR', '1038453', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD SHARIFUDDIN BIN ABDULLAH', '1017059', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ALIF FAIZ BIN DAHARI', '1039766', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ADRIANSYAH BIN ARAHRIOH', '1040114', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('PREMANANTHAN A/L NALLATHAMBI', '1040130', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('YOGENTHIRAN A/L GOVAL KRISNAN', '1040320', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('RAGAVAN A/L MURUKIYAH', '1040325', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD FISOL BIN HASAN', '1040834', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMMAD SHAHRIN IZWAN BIN ASMI', '1041666', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('TENGKU FAIZUL BIN TENGKU YUSOF', '1041704', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMAD HAFIZ AIMAN BIN JAAFAR', '1041757', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD HAMZAH BIN SALONGA', '1041765', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('HASBULLAH BIN SYAMSUDDIN', '1042616', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('HAIZULAMRI BIN AZID', '1044051', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMAD FAIZ BIN OTHMAN', '1044052', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD SHAHMIL BIN MOHD SAAD', '1044249', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD HARUL NIZAM BIN ABD RASHID', '1045529', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD ZULKIFLI BIN YUSUF', '1045784', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ZAINOLAZRIN BIN JAMIL', '1045791', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('ZAFENAS BIN ZAKARIA', '1046952', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('TUAN AHMAD NAZREEN SHAH BIN ZAHARIMAN SHAH', '1047095', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MEGAT LUQMAN HAQIM BIN MEGAT HARMAN SHAH', '1047146', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMAD ASLAM ARIF BIN YAAKUB', '1044058', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MUHAMMAD IZZHARIS HAKIMIE BIN MOHD ZAIDI', '1040781', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD HAZIQ HAIKAL BIN AMRAN', '1009694', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD HANIF BIN HASSAN', '1035899', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('SYED AHMED ZEID AL-JOFFRI', '1045860', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHD RADZI BIN MOHD NORDIN', '1047299', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true),
  ('MOHAMAD FIRDAUS BIN MOHD HAMDAN', '1048085', 'd54882dd-ebc6-4ef0-99cb-14d7b017d335', true);
