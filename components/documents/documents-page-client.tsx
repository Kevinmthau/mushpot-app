"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import { DocumentListClient } from "@/components/documents/document-list-client";
import { useDocumentList } from "@/components/documents/use-document-list";
import PullToRefresh from "@/components/pull-to-refresh";
import { clearLastActiveOwner } from "@/lib/doc-cache";

type DocumentsPageClientProps = {
  initialUserId: string;
};

export function DocumentsPageClient({
  initialUserId,
}: DocumentsPageClientProps) {
  const router = useRouter();
  const { documents, error, refreshDocuments } = useDocumentList(initialUserId);

  const handleSignOut = useCallback(async () => {
    const { getSupabaseBrowserClient } = await import("@/lib/supabase/client");
    const supabase = await getSupabaseBrowserClient();
    await supabase.auth.signOut();
    void clearLastActiveOwner();
    router.replace("/auth");
  }, [router]);

  return (
    <PullToRefresh onRefresh={refreshDocuments}>
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
