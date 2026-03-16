import { notFound } from "next/navigation";

import { SharedDocumentPageClient } from "@/components/editor/shared-document-page-client";

export const dynamic = "force-dynamic";

type SharedDocPageProps = {
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

export default async function SharedDocumentPage({ params }: SharedDocPageProps) {
  const { id, token } = await params;

  const document = await fetchSharedDocument(id, token);

  if (!document) {
    notFound();
  }

  return (
    <SharedDocumentPageClient
      content={document.content}
      documentId={id}
      title={document.title}
      updatedAt={document.updated_at}
    />
  );
}
