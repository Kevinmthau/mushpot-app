"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { EditorClient } from "@/components/editor/editor-lazy";
import {
  getCachedDocumentForOwner,
  putCachedDocument,
  type CachedDocument,
} from "@/lib/doc-cache";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type DocumentPageClientProps = {
  documentId: string;
};

type EditorDocument = Omit<CachedDocument, "_dirty" | "_localUpdatedAt">;

function EditorShell() {
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

export function DocumentPageClient({ documentId }: DocumentPageClientProps) {
  const router = useRouter();
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function loadDocument() {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const sessionUserId = session?.user.id ?? null;

      if (!sessionUserId) {
        router.replace(`/auth?next=/doc/${documentId}`);
        return;
      }

      const cachedDocument = await getCachedDocumentForOwner(documentId, sessionUserId);
      if (!isActive) {
        return;
      }

      if (cachedDocument) {
        setDocument(cachedDocument);
        setStatus("ready");
      }

      const { data: serverDocument, error: documentError } = await supabase
        .from("documents")
        .select("id, owner, title, content, updated_at, share_enabled, share_token")
        .eq("id", documentId)
        .eq("owner", sessionUserId)
        .maybeSingle();

      if (!isActive) {
        return;
      }

      if (documentError) {
        if (!cachedDocument) {
          setError(documentError.message);
          setStatus("error");
        }
        return;
      }

      if (!serverDocument) {
        setStatus("not-found");
        return;
      }

      setDocument(serverDocument);
      setError(null);
      setStatus("ready");
      void putCachedDocument({
        ...serverDocument,
        _dirty: false,
      });
    }

    void loadDocument();

    return () => {
      isActive = false;
    };
  }, [documentId, router]);

  if (!document && status === "loading") {
    return <EditorShell />;
  }

  if (status === "not-found") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6">
          <h1 className="font-[var(--font-writing)] text-2xl text-[var(--ink)]">
            Document not found
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            It may have been deleted or you may not have access to it.
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
    return (
      <main className="mx-auto min-h-dvh w-full max-w-[800px] px-4 py-12 sm:px-5">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-6 text-sm text-[var(--muted)]">
          {error ?? "Unable to load this document."}
        </div>
      </main>
    );
  }

  return <EditorClient initialDocument={document} />;
}
