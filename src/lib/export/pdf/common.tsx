import { Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { APP_NAME } from "@/lib/branding";

export function PdfHeader({ title, code }: { title: string; code: string }) {
  return (
    <View style={s.headerRow}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.formCode}>{code}</Text>
    </View>
  );
}

export function PdfField({ label, value }: { label: string; value: React.ReactNode; full?: boolean }) {
  return (
    <View style={s.fieldBox}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value == null || value === "" ? "-" : String(value)}</Text>
    </View>
  );
}

export function PdfFieldFull({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <View style={s.fieldBoxFull}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{value == null || value === "" ? "-" : String(value)}</Text>
    </View>
  );
}

export function PdfSection({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.sectionTitle}>{title}</Text>
      {note && <Text style={s.note}>{note}</Text>}
      <View style={s.row}>{children}</View>
    </View>
  );
}

export function PdfDisclaimer({ text }: { text: string }) {
  return (
    <View style={s.disclaimer}>
      <Text style={s.disclaimerText}>{text}</Text>
    </View>
  );
}

export function PdfFooter({ submissionId, submittedAt }: { submissionId: string; submittedAt: string }) {
  return (
    <Text style={s.footer} fixed>
      {APP_NAME} · Submission ID {submissionId} · Submitted {submittedAt}
    </Text>
  );
}
