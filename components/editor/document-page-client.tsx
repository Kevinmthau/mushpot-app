"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type DocumentPageClientProps = {
  documentId: string;
};

function EditorPageLoading() {
  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <div className="mb-4 h-10 w-3/4 animate-pulse rounded bg-[var(--line)]" />
        <div className="mb-4 h-4 w-1/4 animate-pulse rounded bg-[var(--line)]" />
        <div className="space-y-3 pt-4">
          <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-4/6 animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--line)]" />
        </div>
      </main>
    </div>
  );
}

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

export function DocumentPageClient({ documentId }: DocumentPageClientProps) {
  const router = useRouter();
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [hasResolvedRemoteState, setHasResolvedRemoteState] = useState(false);

  useEffect(() => {
    let isActive = true;

    void (async () => {
      let cachedDocument: CachedDocument | null = null;

      try {
        const supabase = await getSupabaseBrowserClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!isActive) {
          return;
        }

        const userId = session?.user?.id ?? null;
        if (!userId) {
          setHasResolvedRemoteState(true);
          router.replace(`/auth?next=/doc/${documentId}`);
          return;
        }

        void setLastActiveOwner(userId);

        cachedDocument = await getCachedDocumentForOwner(documentId, userId);
        if (!isActive) {
          return;
        }

        if (cachedDocument) {
          setDocument(toEditorDocument(cachedDocument));
        }

        const { data: serverDoc, error: fetchError } = await supabase
          .from("documents")
          .select("id, owner, title, content, updated_at, share_enabled, share_token")
          .eq("id", documentId)
          .eq("owner", userId)
          .maybeSingle();

        if (!isActive) {
          return;
        }

        setHasResolvedRemoteState(true);

        if (fetchError) {
          if (!cachedDocument) {
            setError(fetchError.message);
          }
          return;
        }

        if (!serverDoc) {
          if (!cachedDocument) {
            setNotFound(true);
          }
          return;
        }

        const reconciled = await reconcileCachedDocumentWithServer({
          ...serverDoc,
          _dirty: false,
        });

        if (!isActive) {
          return;
        }

        const nextDocument = toEditorDocument(reconciled);
        setDocument((current) =>
          current && areDocumentsEqual(current, nextDocument) ? current : nextDocument,
        );
      } catch {
        if (!isActive) {
          return;
        }

        setHasResolvedRemoteState(true);

        if (!cachedDocument) {
          setError("Unable to load document. Please check your connection.");
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [documentId, router]);

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
