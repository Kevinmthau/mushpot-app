"use client";

import Link from "next/link";

import { EditorClient } from "@/components/editor/editor-lazy";
import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import { useEditorDocument } from "@/components/editor/use-editor-document";

import { EditorPageLoading } from "./editor-loading";

type DocumentPageClientProps = {
  documentId: string;
};

export function DocumentPageClient({ documentId }: DocumentPageClientProps) {
  const { document, error, hasResolvedRemoteState, notFound } =
    useEditorDocument(documentId);

  if (error || notFound) {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6">
          <h1 className="font-[var(--font-writing)] text-2xl text-[var(--ink)]">
            {error ? "Unable to load document" : "Document not found"}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {error ?? "It may have been deleted or you may not have access to it."}
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white"
          >
            Back to documents
          </Link>
        </div>
      </main>
    );
  }

  if (!document) {
    return hasResolvedRemoteState ? <MissingDocumentFallback /> : <EditorPageLoading />;
  }

  return <EditorClient key={document.id} initialDocument={document} />;
}
