import { NextResponse } from "next/server";

import { buildDocumentPdf, buildPdfFilename } from "@/lib/pdf/document-pdf";

type SharedDownloadRouteContext = {
  params: Promise<{ id: string; token: string }>;
};

type SharedDoc = {
  title: string;
  content: string;
  updated_at: string;
};

async function fetchSharedDocument(id: string, token: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/get-shared-doc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ docId: id, token }),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as SharedDoc;
}

export async function GET(
  _request: Request,
  { params }: SharedDownloadRouteContext,
) {
  const { id, token } = await params;
  const document = await fetchSharedDocument(id, token);

  if (!document) {
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
      "Cache-Control": "no-store",
    },
  });
}
