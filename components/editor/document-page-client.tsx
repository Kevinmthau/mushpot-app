"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { EditorClient } from "@/components/editor/editor-lazy";
import { MissingDocumentFallback } from "@/components/editor/missing-document-fallback";
import type { EditorDocument } from "@/components/editor/editor-types";
import {
  getCachedDocumentForOwner,
  reconcileCachedDocumentWithServer,
  setLastActiveOwner,
  type CachedDocument,
} from "@/lib/doc-cache";
import { getSupabaseBrowserClient } from "@/lib/document-sync";

type DocumentPageClientProps = {
  documentId: string;
  userId: string;
};

function toEditorDocument(document: CachedDocument): EditorDocument {
  return {
    id: document.id,
    owner: document.owner,
    title: document.title,
    content: document.content,
    updated_at: document.updated_at,
    share_enabled: document.share_enabled,
    share_token: document.share_token,
  };
}

function areDocumentsEqual(left: EditorDocument, right: EditorDocument) {
  return (
    left.id === right.id &&
    left.owner === right.owner &&
    left.title === right.title &&
    left.content === right.content &&
    left.updated_at === right.updated_at &&
    left.share_enabled === right.share_enabled &&
    left.share_token === right.share_token
  );
}

export function DocumentPageClient({ documentId, userId }: DocumentPageClientProps) {
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let isActive = true;

    void (async () => {
      // 1. Try loading from IndexedDB cache instantly
      const cached = await getCachedDocumentForOwner(documentId, userId);
      if (cached && isActive) {
        setDocument(toEditorDocument(cached));
      }

      // 2. Fetch from server in the background
      try {
        const supabase = await getSupabaseBrowserClient();
        const { data: serverDoc, error: fetchError } = await supabase
          .from("documents")
          .select("id, owner, title, content, updated_at, share_enabled, share_token")
          .eq("id", documentId)
          .eq("owner", userId)
          .maybeSingle();

        if (!isActive) return;

        if (fetchError) {
          // If we have a cached version, keep showing it
          if (!cached) {
            setError(fetchError.message);
          }
          return;
        }

        if (!serverDoc) {
          if (!cached) {
            setNotFound(true);
          }
          return;
        }

        // 3. Reconcile server data with cache
        const reconciled = await reconcileCachedDocumentWithServer({
          ...serverDoc,
          _dirty: false,
        });

        if (!isActive) return;

        const nextDocument = toEditorDocument(reconciled);
        setDocument((current) =>
          current && areDocumentsEqual(current, nextDocument) ? current : nextDocument,
        );
      } catch {
        // Network error – if we have cached data, keep showing it
        if (!cached && isActive) {
          setError("Unable to load document. Please check your connection.");
        }
      }
    })();

    void setLastActiveOwner(userId);

    return () => {
      isActive = false;
    };
  }, [documentId, userId]);

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
    return <MissingDocumentFallback />;
  }

  return <EditorClient key={document.id} initialDocument={document} />;
}
