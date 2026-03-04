import { NextResponse } from "next/server";

import { buildDocumentPdf, buildPdfFilename } from "@/lib/pdf/document-pdf";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type DownloadRouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _request: Request,
  { params }: DownloadRouteContext,
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: document, error } = await supabase
    .from("documents")
    .select("title, content, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error || !document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const pdf = buildDocumentPdf({
    title: document.title,
    content: document.content,
    updatedAt: document.updated_at,
  });

  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${buildPdfFilename(
        document.title,
      )}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
