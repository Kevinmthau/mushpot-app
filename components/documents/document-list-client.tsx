"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { preloadEditorClient } from "@/components/editor/editor-lazy";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import {
  type CachedDocument,
  type CachedDocumentListItem,
  putCachedDocument,
  setLastActiveOwner,
} from "@/lib/doc-cache";
import { getSupabaseBrowserClient } from "@/lib/document-sync";

type DocumentListClientProps = {
  documents: CachedDocumentListItem[];
  isLoading?: boolean;
  userId: string | null;
};

export function DocumentListClient({
  documents,
  isLoading = false,
  userId,
}: DocumentListClientProps) {
  const router = useRouter();
  const [displayDocuments, setDisplayDocuments] = useState(documents);
  const [optimisticDocumentIds, setOptimisticDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isCreating, setIsCreating] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setOptimisticDocumentIds((currentIds) => {
      let changed = false;
      const nextIds = new Set(currentIds);

      for (const doc of documents) {
        if (nextIds.delete(doc.id)) {
          changed = true;
        }
      }

      return changed ? nextIds : currentIds;
    });
  }, [documents]);

  useEffect(() => {
    setDisplayDocuments((currentDocuments) => {
      const nextDocumentIds = new Set(documents.map((doc) => doc.id));
      const optimisticDocuments = currentDocuments.filter(
        (doc) => optimisticDocumentIds.has(doc.id) && !nextDocumentIds.has(doc.id),
      );
      return [...optimisticDocuments, ...documents];
    });
  }, [documents, optimisticDocumentIds]);

  const handleWarmEditor = useCallback(() => {
    void preloadEditorClient();
  }, []);

  const handleCreateDocument = useCallback(async () => {
    if (isCreating || !userId) return;
    setIsCreating(true);

    try {
      const supabase = await getSupabaseBrowserClient();
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

      setOptimisticDocumentIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.add(data.id);
        return nextIds;
      });
      setDisplayDocuments((prev) => [
        { id: data.id, title: data.title, updated_at: data.updated_at },
        ...prev,
      ]);

      void preloadEditorClient();
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
