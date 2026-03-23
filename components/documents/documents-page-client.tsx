"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import PullToRefresh from "@/components/pull-to-refresh";
import {
  clearLastActiveOwner,
  getCachedDocumentListForOwner,
  syncDocumentList,
  setLastActiveOwner,
  type CachedDocumentListItem,
} from "@/lib/doc-cache";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function DocumentsPageLoading() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex items-center justify-end sm:mb-10">
        <div className="h-10 w-20 animate-pulse rounded-xl bg-[var(--line)]" />
      </header>

      <section className="space-y-2">
        {Array.from({ length: 6 }, (_, index) => (
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
        ))}
      </section>
    </main>
  );
}

export function DocumentsPageClient() {
  const router = useRouter();
  const [documents, setDocuments] = useState<CachedDocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [hasResolvedRemoteState, setHasResolvedRemoteState] = useState(false);
  const requestIdRef = useRef(0);

  const loadDocuments = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    let cachedDocumentCount = 0;
    setError(null);

    try {
      const supabase = await getSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (requestId !== requestIdRef.current) {
        return;
      }

      const nextUserId = session?.user?.id ?? null;
      if (!nextUserId) {
        setUserId(null);
        setHasResolvedRemoteState(true);
        void clearLastActiveOwner();
        router.replace("/auth?next=/");
        return;
      }

      setUserId(nextUserId);
      void setLastActiveOwner(nextUserId);

      const cachedDocuments = await getCachedDocumentListForOwner(nextUserId);
      if (requestId !== requestIdRef.current) {
        return;
      }

      cachedDocumentCount = cachedDocuments.length;
      setDocuments(cachedDocuments);

      const { data, error: fetchError } = await supabase
        .from("documents")
        .select("id, title, updated_at")
        .eq("owner", nextUserId)
        .order("updated_at", { ascending: false });

      if (requestId !== requestIdRef.current) {
        return;
      }

      setHasResolvedRemoteState(true);

      if (fetchError) {
        if (cachedDocumentCount === 0) {
          setError(fetchError.message);
        }
        return;
      }

      const nextDocuments = (data ?? []) as CachedDocumentListItem[];
      setDocuments(nextDocuments);
      void syncDocumentList(nextDocuments, nextUserId);
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setHasResolvedRemoteState(true);

      if (cachedDocumentCount === 0) {
        setError("Unable to load documents. Please check your connection.");
      }
    }
  }, [router]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDocuments();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      requestIdRef.current += 1;
    };
  }, [loadDocuments]);

  const handleSignOut = useCallback(async () => {
    const supabase = await getSupabaseBrowserClient();
    await supabase.auth.signOut();
    void clearLastActiveOwner();
    router.replace("/auth");
  }, [router]);

  if (!hasResolvedRemoteState && documents.length === 0 && !error) {
    return <DocumentsPageLoading />;
  }

  return (
    <PullToRefresh onRefresh={loadDocuments}>
      <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-6 flex items-center justify-end sm:mb-10">
          <button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
            disabled={!userId}
            className="rounded-xl bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--muted)] transition hover:text-[var(--accent)] disabled:opacity-60"
          >
            Sign out
          </button>
        </header>

        {error && documents.length === 0 ? (
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-5 text-sm text-[var(--muted)] sm:px-5">
            {error}
          </section>
        ) : (
          <DocumentListClient documents={documents} userId={userId} />
        )}
      </main>
    </PullToRefresh>
  );
}
