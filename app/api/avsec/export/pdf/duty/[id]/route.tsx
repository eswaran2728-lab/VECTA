import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireProfile } from "@/lib/avsec/auth";
import { getDutyRecordDetail } from "@/lib/avsec/duty/timesheet-queries";
import { getDutyZone } from "@/lib/avsec/duty/checkin-queries";
import { createClient } from "@/lib/avsec/supabase/server";
import { DutyRecordPdf } from "@/lib/avsec/export/pdf/DutyRecordPdf";

export async function GET(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  await requireProfile();

  // RLS scopes this to records the caller may see (own, or monitor within rank/station/team).
  const record = await getDutyRecordDetail(params.id);
  if (!record) {
    return NextResponse.json({ error: "Duty record not found" }, { status: 404 });
  }

  const [zone, submitter] = await Promise.all([
    record.zone_id ? getDutyZone(record.zone_id) : Promise.resolve(null),
    (await createClient()).from("profiles").select("name, staff_no").eq("id", record.profile_id).maybeSingle(),
  ]);

  const buffer = await renderToBuffer(
    <DutyRecordPdf
      record={record}
      staffName={submitter.data?.name ?? "—"}
      staffNo={submitter.data?.staff_no ?? "—"}
      zoneName={zone?.name ?? null}
    />,
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="duty-${params.id}.pdf"`,
    },
  });
}
