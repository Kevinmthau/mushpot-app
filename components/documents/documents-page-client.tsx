"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import PullToRefresh from "@/components/pull-to-refresh";
import {
  getAllCachedDocumentsForOwner,
  syncDocumentList,
  type CachedDocumentListItem,
} from "@/lib/doc-cache";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function DocumentsPageClient() {
  const router = useRouter();
  const [documents, setDocuments] = useState<CachedDocumentListItem[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    async function loadDocuments() {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const sessionUserId = session?.user.id ?? null;

      if (!sessionUserId) {
        router.replace("/auth?next=/");
        return;
      }

      if (!isActive) {
        return;
      }

      setUserId(sessionUserId);

      const cachedDocsPromise = getAllCachedDocumentsForOwner(sessionUserId);
      const serverDocsPromise = supabase
        .from("documents")
        .select("id, title, updated_at")
        .order("updated_at", { ascending: false });

      const cachedDocs = await cachedDocsPromise;
      if (!isActive) {
        return;
      }

      if (cachedDocs.length > 0) {
        setDocuments(cachedDocs);
        setIsLoading(false);
      }

      const { data: serverDocs, error: documentsError } = await serverDocsPromise;
      if (!isActive) {
        return;
      }

      if (documentsError) {
        if (cachedDocs.length === 0) {
          setError(documentsError.message);
          setIsLoading(false);
        }
        return;
      }

      const nextDocuments = serverDocs ?? [];
      setDocuments(nextDocuments);
      setError(null);
      setIsLoading(false);
      void syncDocumentList(nextDocuments, sessionUserId);
    }

    void loadDocuments();

    return () => {
      isActive = false;
    };
  }, [router]);

  const handleSignOut = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/auth");
    router.refresh();
  }, [router]);

  return (
    <PullToRefresh>
      <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-6 flex items-center justify-end sm:mb-10">
          <button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
            className="rounded-xl bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--muted)] transition hover:text-[var(--accent)]"
          >
            Sign out
          </button>
        </header>

        {error && documents.length === 0 ? (
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-4 py-5 text-sm text-[var(--muted)] sm:px-5">
            {error}
          </section>
        ) : (
          <DocumentListClient
            documents={documents}
            isLoading={isLoading}
            userId={userId}
          />
        )}
      </main>
    </PullToRefresh>
  );
}
