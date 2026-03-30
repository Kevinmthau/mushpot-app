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

type DocumentsPageClientProps = {
  initialUserId: string;
};

export function DocumentsPageClient({
  initialUserId,
}: DocumentsPageClientProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState<CachedDocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const hasDocumentsRef = useRef(false);
  hasDocumentsRef.current = documents.length > 0;

  // Eagerly start loading the Supabase module so it's warm by the time we need it
  const supabaseModuleRef = useRef<Promise<typeof import("@/lib/supabase/client")> | null>(null);
  if (!supabaseModuleRef.current) {
    supabaseModuleRef.current = import("@/lib/supabase/client");
  }

  const loadDocuments = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setError(null);

    try {
      const { getSupabaseBrowserClient } = await supabaseModuleRef.current!;
      const supabase = await getSupabaseBrowserClient();
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select("id, title, updated_at")
        .eq("owner", initialUserId)
        .order("updated_at", { ascending: false });

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (fetchError) {
        if (!hasDocumentsRef.current) {
          setError(fetchError.message);
        }
        return;
      }

      const nextDocuments = (data ?? []) as CachedDocumentListItem[];
      setDocuments(nextDocuments);
      void syncDocumentList(nextDocuments, initialUserId);
    } catch {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!hasDocumentsRef.current) {
        setError("Unable to load documents. Please check your connection.");
      }
    }
  }, [initialUserId]);

  useEffect(() => {
    let isActive = true;

    void setLastActiveOwner(initialUserId);

    // Show cached data from IndexedDB for instant display
    void getCachedDocumentListForOwner(initialUserId).then((cached) => {
      if (!isActive || cached.length === 0) return;
      setDocuments(cached);
    });

    // Refresh from Supabase in background
    void loadDocuments();

    return () => {
      isActive = false;
      requestIdRef.current += 1;
    };
  }, [initialUserId, loadDocuments]);

  const handleSignOut = useCallback(async () => {
    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    const supabase = await getSupabaseBrowserClient();
    await supabase.auth.signOut();
    void clearLastActiveOwner();
    router.replace("/auth");
  }, [router]);

  return (
    <PullToRefresh onRefresh={loadDocuments}>
      <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-6 flex items-center justify-end sm:mb-10">
          <button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
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
          <DocumentListClient documents={documents} userId={initialUserId} />
        )}
      </main>
    </PullToRefresh>
  );
}
