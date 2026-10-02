"use client";

import { useSyncExternalStore } from "react";

import { DocumentListClient } from "@/components/documents/document-list-client";
import { DocumentsPageLoading } from "@/components/documents/document-list-loading";
import { usePrivateSession } from "@/components/pwa/private-session-provider";

/** Show retained rows while Next waits for the returning document-list route. */
export function RetainedDocumentsPageLoading() {
  const { documentListSession, userId, writeSession } = usePrivateSession();
  const documents = useSyncExternalStore(
    documentListSession.subscribe,
    documentListSession.getSnapshot,
    documentListSession.getServerSnapshot,
  );

  if (!userId || !documentListSession.isCurrent(userId) || documents === null) {
    return <DocumentsPageLoading />;
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex items-center justify-end sm:mb-10">
        <div
          aria-hidden="true"
          className="h-10 w-20 animate-pulse rounded-xl bg-[var(--line)]"
        />
      </header>

      <DocumentListClient
        key={userId}
        documents={documents}
        userId={userId}
        writeSession={writeSession}
        documentListSession={documentListSession}
      />
    </main>
  );
}
