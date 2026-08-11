import { StyleSheet } from "@react-pdf/renderer";

export const pdfStyles = StyleSheet.create({
  page: { padding: 28, fontSize: 9, fontFamily: "Helvetica" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontSize: 13, fontWeight: 700 },
  formCode: { fontSize: 9, fontFamily: "Helvetica-Bold", padding: 4, backgroundColor: "#0f172a", color: "#fff" },
  section: { marginBottom: 10, borderWidth: 1, borderColor: "#cbd5e1", borderStyle: "solid", padding: 8 },
  sectionTitle: { fontSize: 10, fontWeight: 700, marginBottom: 6, textTransform: "uppercase" },
  row: { flexDirection: "row", flexWrap: "wrap", marginBottom: 2 },
  fieldBox: { width: "50%", marginBottom: 4, paddingRight: 6 },
  fieldBoxFull: { width: "100%", marginBottom: 4 },
  label: { fontSize: 7, color: "#64748b", textTransform: "uppercase" },
  value: { fontSize: 9, fontWeight: 700 },
  note: { fontSize: 8, backgroundColor: "#fffbeb", color: "#92400e", padding: 4, marginBottom: 6 },
  disclaimer: {
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fca5a5",
    borderStyle: "solid",
    padding: 6,
    marginBottom: 10,
  },
  disclaimerText: { fontSize: 7, color: "#991b1b", fontFamily: "Helvetica-Bold" },
  checklistRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
    paddingVertical: 3,
  },
  footer: { position: "absolute", bottom: 16, left: 28, right: 28, fontSize: 7, color: "#94a3b8", textAlign: "center" },
});
