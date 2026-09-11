import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const filename = id.endsWith(".pdf") ? id : `${id}.pdf`;
    const filePath = path.join(process.cwd(), "public", "docs", filename);

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": fileBuffer.length.toString(),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to download document";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
