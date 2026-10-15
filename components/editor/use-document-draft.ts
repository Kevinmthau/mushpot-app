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
import { getDocumentPlainText } from "@/lib/page-document";

const UNSAVABLE_DRAFT_HISTORY_KEY = "__mushpotUnsavableDraftGuard";

function hasDraftNavigationGuard(
  value: unknown,
  guardId: string,
) {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)[UNSAVABLE_DRAFT_HISTORY_KEY] === guardId;
}

/**
 * Keep a same-URL history entry above the editor while its draft cannot be
 * serialized. The Navigation API blocks before a supported browser commits a
 * soft navigation; the history entry is the fallback for browser Back.
 */
export function installUnsavableDraftNavigationGuard() {
  const guardId = `${Date.now()}-${Math.random()}`;
  const currentState = window.history.state;
  const guardState = typeof currentState === "object" && currentState !== null
    ? { ...currentState, [UNSAVABLE_DRAFT_HISTORY_KEY]: guardId }
    : { [UNSAVABLE_DRAFT_HISTORY_KEY]: guardId };
  window.history.pushState(guardState, "", window.location.href);

  const navigation = (window as Window & { navigation?: EventTarget })
    .navigation;
  const handleNavigate = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const handlePopState = (event: PopStateEvent) => {
    if (hasDraftNavigationGuard(event.state, guardId)) return;
    window.history.forward();
  };
  const handleDocumentClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }

    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || anchor.target === "_blank") {
      return;
    }

    const destination = new URL(anchor.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      (destination.pathname === window.location.pathname &&
        destination.search === window.location.search)
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  if (navigation) {
    navigation.addEventListener("navigate", handleNavigate);
  } else {
    window.addEventListener("popstate", handlePopState);
  }
  document.addEventListener("click", handleDocumentClick, true);

  return () => {
    navigation?.removeEventListener("navigate", handleNavigate);
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("click", handleDocumentClick, true);
    if (hasDraftNavigationGuard(window.history.state, guardId)) {
      // Return to the original same-URL entry so the guard does not leave an
      // extra Back stop after the draft becomes serializable again.
      window.history.back();
    }
  };
}

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
  const statsSource = useMemo(
    () => ({
      content: view.contentForStats,
      contentFormat: view.contentFormat,
    }),
    [view.contentForStats, view.contentFormat],
  );
  const deferredStatsSource = useDeferredValue(statsSource);

  useEffect(() => {
    controller.setPersistence(persistence);
    const lifecycle = controller.start((next) => {
      setView(next);
    });
    const handleVisibility = () =>
      lifecycle.handleVisibilityChange(document.visibilityState);
    window.addEventListener("beforeunload", lifecycle.handleBeforeUnload);
    window.addEventListener("pagehide", lifecycle.handlePageHide);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("beforeunload", lifecycle.handleBeforeUnload);
      window.removeEventListener("pagehide", lifecycle.handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibility);
      lifecycle.stop();
    };
  }, [controller, persistence]);

  useEffect(() => {
    controller.hydrate(initialDocument, hasResolvedRemoteState);
  }, [controller, hasResolvedRemoteState, initialDocument]);

  useEffect(() => {
    if (view.draftSerializationError === null || view.isDeleting) return;
    return installUnsavableDraftNavigationGuard();
  }, [view.draftSerializationError, view.isDeleting]);

  const readingTime = useMemo(
    () => getReadingTimeFromText(
      getDocumentPlainText(
        deferredStatsSource.content,
        deferredStatsSource.contentFormat,
      ),
    ),
    [deferredStatsSource],
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
