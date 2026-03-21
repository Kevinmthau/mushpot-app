"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import PullToRefresh from "@/components/pull-to-refresh";
import {
  clearLastActiveOwner,
  setLastActiveOwner,
  syncDocumentList,
  type CachedDocumentListItem,
} from "@/lib/doc-cache";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type DocumentsPageClientProps = {
  documents: CachedDocumentListItem[];
  error: string | null;
  userId: string;
};

export function DocumentsPageClient({ documents, error, userId }: DocumentsPageClientProps) {
  const router = useRouter();

  useEffect(() => {
    void setLastActiveOwner(userId);
    void syncDocumentList(documents, userId);
  }, [documents, userId]);

  const handleSignOut = useCallback(async () => {
    const supabase = await getSupabaseBrowserClient();
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
            userId={userId}
          />
        )}
      </main>
    </PullToRefresh>
  );
}
