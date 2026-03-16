"use client";

import { useEffect } from "react";

import { EditorClient } from "@/components/editor/editor-lazy";
import { putCachedDocument, setLastActiveOwner } from "@/lib/doc-cache";
import type { EditorDocument } from "@/components/editor/editor-client";

type DocumentPageClientProps = {
  initialDocument: EditorDocument;
};

function MissingDocumentFallback() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6">
        <h1 className="font-[var(--font-writing)] text-2xl text-[var(--ink)]">
          Unable to open document
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          This page data is out of date. Refresh to load the latest version.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm text-white"
        >
          Refresh
        </button>
      </div>
    </main>
  );
}

export function DocumentPageClient(props: DocumentPageClientProps) {
  const initialDocument = props?.initialDocument;

  if (!initialDocument) {
    return <MissingDocumentFallback />;
  }

  return <DocumentPageClientInner initialDocument={initialDocument} />;
}

function DocumentPageClientInner({ initialDocument }: DocumentPageClientProps) {
  useEffect(() => {
    void putCachedDocument({
      ...initialDocument,
      _dirty: false,
    });
    void setLastActiveOwner(initialDocument.owner);
  }, [initialDocument]);

  return <EditorClient initialDocument={initialDocument} />;
}
