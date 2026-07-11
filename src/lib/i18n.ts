export type Lang = "en" | "ms";

/**
 * Simple EN / Bahasa Melayu dictionary. Checkpoint screens (the highest
 * traffic surfaces) are fully covered; the language is persisted per user
 * (users.preferred_language) and per device (cscs-lang cookie).
 */
const DICT = {
  vehicle_verified: {
    en: "Vehicle verified",
    ms: "Kenderaan disahkan",
  },
  vehicle_verified_desc: {
    en: "Plate matches the record above.",
    ms: "Nombor plat sepadan dengan rekod di atas.",
  },
  driver_verified: {
    en: "Driver verified",
    ms: "Pemandu disahkan",
  },
  driver_verified_desc: {
    en: "ID document matches name and driver ID.",
    ms: "Dokumen pengenalan sepadan dengan nama dan ID pemandu.",
  },
  seal_verification: {
    en: "Seal verification — enter each seal number as physically read",
    ms: "Pengesahan sil — masukkan setiap nombor sil seperti yang dibaca",
  },
  seal_mismatch_note: {
    en: "Any mismatch automatically raises a Seal Mismatch incident and escalates the transaction.",
    ms: "Sebarang ketidakpadanan akan menimbulkan insiden dan mengeskalasi transaksi secara automatik.",
  },
  seals_intact: {
    en: "Seals intact on arrival",
    ms: "Sil dalam keadaan baik semasa tiba",
  },
  seals_intact_desc: {
    en: "No cuts, tampering or re-sealing visible on any seal.",
    ms: "Tiada kesan potongan, gangguan atau sil semula pada mana-mana sil.",
  },
  remarks_optional: {
    en: "Remarks (optional)",
    ms: "Catatan (pilihan)",
  },
  officer: { en: "Officer", ms: "Pegawai" },
  receiver: { en: "Receiver", ms: "Penerima" },
  vehicle: { en: "Vehicle", ms: "Kenderaan" },
  driver: { en: "Driver", ms: "Pemandu" },
  driver_id: { en: "Driver ID", ms: "ID Pemandu" },
  delivery_location: { en: "Delivery Location", ms: "Lokasi Penghantaran" },
  select_location: { en: "Select location…", ms: "Pilih lokasi…" },
  signature: { en: "Signature", ms: "Tandatangan" },
  signature_hint: {
    en: "Sign inside the box using your finger or a stylus.",
    ms: "Tandatangan di dalam kotak menggunakan jari atau stylus.",
  },
  approve_release: { en: "Approve & Release", ms: "Lulus & Lepaskan" },
  approve_complete: {
    en: "Approve & Complete Transaction",
    ms: "Lulus & Lengkapkan Transaksi",
  },
  confirm_delivery: {
    en: "Confirm Delivery — Complete",
    ms: "Sahkan Penghantaran — Lengkap",
  },
  verification_failed: {
    en: "Verification failed — Report Incident",
    ms: "Pengesahan gagal — Lapor Insiden",
  },
  seal_problem: {
    en: "Seal problem — Report Incident",
    ms: "Masalah sil — Lapor Insiden",
  },
  saving: { en: "Saving…", ms: "Menyimpan…" },
  clear: { en: "Clear", ms: "Padam" },
  final_checkpoint_note: {
    en: "Final checkpoint — approving here completes this inbound transaction.",
    ms: "Pusat pemeriksaan terakhir — kelulusan di sini melengkapkan transaksi masuk ini.",
  },
  enter_seal_placeholder: { en: "Enter seal number…", ms: "Masukkan nombor sil…" },
} as const;

export type DictKey = keyof typeof DICT;

export function t(lang: Lang, key: DictKey): string {
  return DICT[key][lang];
}

export function isLang(value: string | undefined | null): value is Lang {
  return value === "en" || value === "ms";
}
