import { DocumentPageClient } from "@/components/editor/document-page-client";

type DocPageProps = {
  params: Promise<{ id: string }>;
};

export default async function DocumentEditorPage({ params }: DocPageProps) {
  const { id } = await params;

  return <DocumentPageClient documentId={id} />;
}
