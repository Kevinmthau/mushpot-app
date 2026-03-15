"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import {
  type CachedDocument,
  type CachedDocumentListItem,
  putCachedDocument,
  setLastActiveOwner,
} from "@/lib/doc-cache";

type DocumentListClientProps = {
  documents: CachedDocumentListItem[];
  isLoading?: boolean;
  userId: string | null;
};

let editorChunkPreloaded = false;

function preloadEditorChunk() {
  if (editorChunkPreloaded) {
    return;
  }

  editorChunkPreloaded = true;
  void import("@/components/editor/editor-client").catch(() => {
    editorChunkPreloaded = false;
  });
}

export function DocumentListClient({
  documents,
  isLoading = false,
  userId,
}: DocumentListClientProps) {
  const router = useRouter();
  const [displayDocuments, setDisplayDocuments] = useState(documents);
  const [isCreating, setIsCreating] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setDisplayDocuments((currentDocuments) => {
      const nextDocumentIds = new Set(documents.map((doc) => doc.id));
      const optimisticDocuments = currentDocuments.filter(
        (doc) => !nextDocumentIds.has(doc.id),
      );
      return [...optimisticDocuments, ...documents];
    });
  }, [documents]);

  const handleWarmEditor = useCallback(() => {
    preloadEditorChunk();
  }, []);

  const handleCreateDocument = useCallback(async () => {
    if (isCreating || !userId) return;
    setIsCreating(true);

    try {
      const { createSupabaseBrowserClient } = await import("@/lib/supabase/client");
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("documents")
        .insert({ owner: userId, title: "Untitled", content: "" })
        .select("id, owner, title, content, updated_at, share_enabled, share_token")
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unable to create document.");
      }

      const cachedDocument: CachedDocument = {
        id: data.id,
        owner: data.owner,
        title: data.title,
        content: data.content,
        updated_at: data.updated_at,
        share_enabled: data.share_enabled,
        share_token: data.share_token,
        _dirty: false,
      };
      await putCachedDocument(cachedDocument);
      void setLastActiveOwner(data.owner);

      setDisplayDocuments((prev) => [
        { id: data.id, title: data.title, updated_at: data.updated_at },
        ...prev,
      ]);

      preloadEditorChunk();
      startTransition(() => {
        router.push(`/doc/${data.id}`);
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to create document.");
      setIsCreating(false);
    }
  }, [isCreating, userId, router]);

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={handleCreateDocument}
        onFocus={handleWarmEditor}
        onPointerEnter={handleWarmEditor}
        onTouchStart={handleWarmEditor}
        disabled={isCreating || !userId}
        aria-label="New document"
        title="New document"
        className="group block w-full appearance-none rounded-2xl border-0 bg-transparent p-0 text-left transition hover:bg-[var(--paper)] hover:shadow-[0_8px_22px_rgba(41,60,68,0.08)] disabled:opacity-60"
      >
        <div className="px-4 py-3 sm:px-5 sm:py-4">
          <p className="document-title-text line-clamp-1 text-[var(--muted)]">
            {isCreating ? "Creating..." : "New document..."}
          </p>
        </div>
      </button>

      {isLoading && displayDocuments.length === 0
        ? Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="rounded-2xl bg-[var(--paper)] px-4 py-3 sm:px-5 sm:py-4"
            >
              <div
                className="h-5 animate-pulse rounded bg-[var(--line)]"
                style={{ width: `${65 - index * 8}%` }}
              />
              <div className="mt-2 h-3 w-16 animate-pulse rounded bg-[var(--line)]" />
            </div>
          ))
        : null}

      {displayDocuments.map((doc) => (
        <Link
          key={doc.id}
          href={`/doc/${doc.id}`}
          prefetch={true}
          onFocus={handleWarmEditor}
          onPointerEnter={handleWarmEditor}
          onTouchStart={handleWarmEditor}
          className="group block rounded-2xl bg-[var(--paper)] px-4 py-3 transition hover:shadow-[0_8px_22px_rgba(41,60,68,0.08)] sm:px-5 sm:py-4"
        >
          <p className="document-title-text line-clamp-1 text-[var(--ink)]">
            {doc.title || "Untitled"}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {formatRelativeTimestamp(doc.updated_at)}
          </p>
        </Link>
      ))}
    </section>
  );
}
