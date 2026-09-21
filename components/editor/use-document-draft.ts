"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";

import {
  DocumentDraftController,
  type DraftPersistenceOptions,
} from "@/components/editor/document-draft-controller";
import type { EditorDocument } from "@/components/editor/editor-types";
import { usePrivateSession } from "@/components/pwa/private-session-provider";
import { getDocumentCacheWriteToken, putCachedDocument } from "@/lib/doc-cache";
import { getReadingTimeFromText } from "@/lib/document-stats";
import {
  persistDocumentSnapshot,
  subscribeToDocumentWrites,
} from "@/lib/document-sync";
import type { DocumentWriteSession } from "@/lib/document-write-coordinator";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";

function createDraftPersistence(
  owner: string,
  writeSession: DocumentWriteSession,
): DraftPersistenceOptions {
  const ownsDraft = () => writeSession.active && writeSession.owner === owner;
  let cacheWriteToken = ownsDraft() ? getDocumentCacheWriteToken(owner) : null;
  const resolveCacheToken = () => {
    // Adopt the first available generation after IndexedDB recovery, but
    // never cross a revocation within this authentication lifetime.
    if (cacheWriteToken === null && ownsDraft()) {
      cacheWriteToken = getDocumentCacheWriteToken(owner);
    }
    return cacheWriteToken;
  };
  return {
    canPersist: () => {
      const captured = resolveCacheToken();
      const current = getDocumentCacheWriteToken(owner);
      return ownsDraft() && captured?.generation === current?.generation;
    },
    cache: (snapshot) =>
      ownsDraft()
        ? putCachedDocument(snapshot, resolveCacheToken())
        : Promise.resolve(false),
    persist: (snapshot) =>
      persistDocumentSnapshot(snapshot, resolveCacheToken(), writeSession),
    subscribe: (listener) =>
      subscribeToDocumentWrites((event, scope) => {
        if (scope.session === writeSession) listener(event);
      }),
  };
}

export function useDocumentDraft(
  initialDocument: EditorDocument,
  hasResolvedRemoteState: boolean,
) {
  const { writeSession } = usePrivateSession();
  const persistence = useMemo(
    () => createDraftPersistence(initialDocument.owner, writeSession),
    [initialDocument.owner, writeSession],
  );
  // Preserve the draft if authentication renews while this editor stays mounted.
  const [controller] = useState(
    () =>
      new DocumentDraftController(
        initialDocument,
        hasResolvedRemoteState,
        persistence,
      ),
  );
  const [view, setView] = useState(controller.getView);
  const deferredContent = useDeferredValue(view.contentForStats);

  useEffect(() => {
    controller.setPersistence(persistence);
    const lifecycle = controller.start((next) => {
      setView(next);
    });
    const handleVisibility = () =>
      lifecycle.handleVisibilityChange(document.visibilityState);
    window.addEventListener("pagehide", lifecycle.handlePageHide);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", lifecycle.handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibility);
      lifecycle.stop();
    };
  }, [controller, persistence]);

  useEffect(() => {
    controller.hydrate(initialDocument, hasResolvedRemoteState);
  }, [controller, hasResolvedRemoteState, initialDocument]);

  const readingTime = useMemo(
    () => getReadingTimeFromText(deferredContent),
    [deferredContent],
  );
  const formattedUpdated = useMemo(
    () => formatRelativeTimestamp(view.updatedAt),
    [view.updatedAt],
  );

  return {
    ...view,
    formattedUpdated,
    readingTime,
    flushLatestDraft: controller.flushLatestDraft,
    getLatestContent: controller.getLatestContent,
    getLatestTitle: controller.getLatestTitle,
    handleEditorChange: controller.handleEditorChange,
    handleTitleChange: controller.handleTitleChange,
    handleTitleBlur: controller.handleTitleBlur,
    markDeleting: controller.markDeleting,
    resetDeletingState: controller.resetDeletingState,
    updateShareState: controller.updateShareState,
  };
}
