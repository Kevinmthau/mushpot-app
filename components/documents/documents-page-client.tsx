"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import PullToRefresh from "@/components/pull-to-refresh";
import {
  clearLastActiveOwner,
  getAllCachedDocumentsForOwner,
  getLastActiveOwner,
  setLastActiveOwner,
  syncDocumentList,
  type CachedDocumentListItem,
} from "@/lib/doc-cache";

type DocumentsPageClientProps = {
  initialDocuments: CachedDocumentListItem[];
  initialError: string | null;
  initialUserId: string | null;
};

function scheduleDeferredTask(task: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => task(), { timeout: 1200 });
    return () => {
      idleWindow.cancelIdleCallback?.(handle);
    };
  }

  const timeoutId = window.setTimeout(task, 400);
  return () => {
    window.clearTimeout(timeoutId);
  };
}

export function DocumentsPageClient({
  initialDocuments,
  initialError,
  initialUserId,
}: DocumentsPageClientProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState<CachedDocumentListItem[]>(initialDocuments);
  const [userId, setUserId] = useState<string | null>(initialUserId);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(
    initialDocuments.length === 0 && initialError === null,
  );

  useEffect(() => {
    let isActive = true;

    async function loadDocuments() {
      let ownerId = initialUserId;
      let hasVisibleDocuments = initialDocuments.length > 0;

      if (!ownerId) {
        ownerId = await getLastActiveOwner();
      }

      if (!ownerId) {
        router.replace("/auth?next=/");
        return;
      }

      if (!isActive) {
        return;
      }

      setUserId(ownerId);
      void setLastActiveOwner(ownerId);

      if (initialDocuments.length > 0) {
        setDocuments(initialDocuments);
        setError(initialError);
        setIsLoading(false);
        void syncDocumentList(initialDocuments, ownerId);
      } else {
        const cachedDocs = await getAllCachedDocumentsForOwner(ownerId);
        if (!isActive) {
          return;
        }

        if (cachedDocs.length > 0) {
          setDocuments(cachedDocs);
          setError(null);
          setIsLoading(false);
          hasVisibleDocuments = true;
        }
      }

      const cancelDeferredRefresh = scheduleDeferredTask(() => {
        void (async () => {
          const { createSupabaseBrowserClient } = await import("@/lib/supabase/client");
          const supabase = createSupabaseBrowserClient();
          const { data: serverDocs, error: documentsError } = await supabase
            .from("documents")
            .select("id, title, updated_at")
            .eq("owner", ownerId)
            .order("updated_at", { ascending: false });

          if (!isActive) {
            return;
          }

          if (documentsError) {
            if (!hasVisibleDocuments) {
              setError(documentsError.message);
              setIsLoading(false);
            }
            return;
          }

          const nextDocuments = serverDocs ?? [];
          setDocuments(nextDocuments);
          setError(null);
          setIsLoading(false);
          void syncDocumentList(nextDocuments, ownerId);
        })();
      });

      return cancelDeferredRefresh;
    }

    let cancelDeferredRefresh: (() => void) | undefined;
    void loadDocuments().then((cancelRefresh) => {
      cancelDeferredRefresh = cancelRefresh;
    });

    return () => {
      isActive = false;
      cancelDeferredRefresh?.();
    };
  }, [initialDocuments, initialError, initialUserId, router]);

  const handleSignOut = useCallback(async () => {
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/client");
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    void clearLastActiveOwner();
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
