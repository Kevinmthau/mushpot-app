"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { formatRelativeTimestamp } from "@/lib/format-relative-time";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  type CachedDocumentListItem,
  getAllCachedDocuments,
  putCachedDocument,
  syncDocumentList,
} from "@/lib/doc-cache";

type DocumentListClientProps = {
  /** Server-fetched documents, used as initial data + to seed cache */
  serverDocuments: CachedDocumentListItem[];
  userId: string;
};

/**
 * Preload the editor chunk when idle so opening a document is instant.
 */
function preloadEditorChunk() {
  if (typeof window === "undefined") return;

  const preload = () => {
    import("@/components/editor/editor-client").catch(() => {
      // Preload is best-effort
    });
  };

  if ("requestIdleCallback" in window) {
    (window as Window).requestIdleCallback(preload, { timeout: 3000 });
  } else {
    setTimeout(preload, 1500);
  }
}

export function DocumentListClient({
  serverDocuments,
  userId,
}: DocumentListClientProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState(serverDocuments);
  const [isCreating, setIsCreating] = useState(false);
  const [, startTransition] = useTransition();
  const hasSynced = useRef(false);

  // Seed the cache with server data and preload editor
  useEffect(() => {
    if (hasSynced.current) return;
    hasSynced.current = true;
    syncDocumentList(serverDocuments);
    preloadEditorChunk();
  }, [serverDocuments]);

  // Also load from cache to show any locally-created docs instantly
  useEffect(() => {
    getAllCachedDocuments().then((cached) => {
      if (cached.length > 0) {
        // Merge: prefer server data but include cache-only docs
        const serverIds = new Set(serverDocuments.map((d) => d.id));
        const cacheOnly = cached.filter((d) => !serverIds.has(d.id));
        if (cacheOnly.length > 0) {
          setDocuments((prev) => [...cacheOnly, ...prev]);
        }
      }
    });
  }, [serverDocuments]);

  const handleCreateDocument = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);

    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("documents")
        .insert({ owner: userId, title: "Untitled", content: "" })
        .select("id, owner, title, content, updated_at, share_enabled, share_token")
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unable to create document.");
      }

      // Cache immediately for instant loading
      await putCachedDocument({
        id: data.id,
        owner: data.owner,
        title: data.title,
        content: data.content,
        updated_at: data.updated_at,
        share_enabled: data.share_enabled,
        share_token: data.share_token,
      });

      // Optimistic navigation – add to list and navigate
      setDocuments((prev) => [
        { id: data.id, title: data.title, updated_at: data.updated_at },
        ...prev,
      ]);

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
        disabled={isCreating}
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

      {documents?.map((doc) => (
        <Link
          key={doc.id}
          href={`/doc/${doc.id}`}
          prefetch={true}
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
