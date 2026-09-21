"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { DocumentDraftController } from "@/components/editor/document-draft-controller";
import type { EditorDocument } from "@/components/editor/editor-types";
import { usePrivateSession } from "@/components/pwa/private-session-provider";
import { getDocumentCacheWriteToken, putCachedDocument } from "@/lib/doc-cache";
import { getReadingTimeFromText } from "@/lib/document-stats";
import {
  persistDocumentSnapshot,
  subscribeToDocumentWrites,
} from "@/lib/document-sync";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";

export function useDocumentDraft(
  initialDocument: EditorDocument,
  hasResolvedRemoteState: boolean,
) {
  const { writeSession } = usePrivateSession();
  // The editor is keyed by document id; one controller follows that mounted
  // editor and its authentication lifetime, including StrictMode replay.
  const [controller] = useState(() => {
    let cacheWriteToken = getDocumentCacheWriteToken(initialDocument.owner);
    const resolveCacheToken = () => {
      // IndexedDB can become available after this editor mounts. Adopt its
      // first generation once; never cross a revoked generation afterward.
      if (cacheWriteToken === null && writeSession.active) {
        cacheWriteToken = getDocumentCacheWriteToken(initialDocument.owner);
      }
      return cacheWriteToken;
    };
    return new DocumentDraftController(
      initialDocument,
      hasResolvedRemoteState,
      {
        canPersist: () => {
          const captured = resolveCacheToken();
          const current = getDocumentCacheWriteToken(initialDocument.owner);
          return (
            writeSession.active && captured?.generation === current?.generation
          );
        },
        cache: (snapshot) =>
          writeSession.active
            ? putCachedDocument(snapshot, resolveCacheToken())
            : Promise.resolve(false),
        persist: (snapshot) =>
          persistDocumentSnapshot(snapshot, resolveCacheToken(), writeSession),
        subscribe: (listener) =>
          subscribeToDocumentWrites((event, scope) => {
            if (scope.session === writeSession) listener(event);
          }),
      },
    );
  });
  const [view, setView] = useState(controller.getView);
  const deferredContent = useDeferredValue(view.contentForStats);

  useEffect(() => {
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
  }, [controller]);

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
