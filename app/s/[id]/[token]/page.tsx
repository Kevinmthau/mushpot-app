import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedDocumentPageClient } from "@/components/editor/shared-document-page-client";
import {
  buildSharedDocumentPreview,
  fetchSharedDocument,
  normalizeSharedDocumentTitle,
  resolveAppOrigin,
} from "@/lib/shared-document";

export const dynamic = "force-dynamic";

type SharedDocPageProps = {
  params: Promise<{ id: string; token: string }>;
};

export async function generateMetadata({
  params,
}: SharedDocPageProps): Promise<Metadata> {
  const { id, token } = await params;
  const document = await fetchSharedDocument(id, token);
  const origin = await resolveAppOrigin();

  if (!document) {
    return {
      title: "Shared document | Mushpot",
      description: "Open this shared document in Mushpot.",
      metadataBase: origin ? new URL(origin) : undefined,
    };
  }

  const title = normalizeSharedDocumentTitle(document.title);
  const description = buildSharedDocumentPreview(document.content);
  const sharePath = `/s/${id}/${token}`;
  const ogImagePath = `${sharePath}/opengraph-image`;

  return {
    metadataBase: origin ? new URL(origin) : undefined,
    title: `${title} | Mushpot`,
    description,
    alternates: {
      canonical: sharePath,
    },
    openGraph: {
      type: "article",
      siteName: "Mushpot",
      title,
      description,
      url: sharePath,
      images: [
        {
          url: ogImagePath,
          width: 1200,
          height: 630,
          alt: `${title} preview`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImagePath],
    },
  };
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
