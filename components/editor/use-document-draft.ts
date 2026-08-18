"use client";

import { type Text } from "@codemirror/state";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { readDocumentText } from "@/components/editor/read-document-text";
import type { EditorDocument } from "@/components/editor/editor-types";
import { putCachedDocument, type CachedDocument } from "@/lib/doc-cache";
import { getReadingTimeFromText } from "@/lib/document-stats";
import { persistDocumentSnapshot } from "@/lib/document-sync";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";

const AUTOSAVE_DEBOUNCE_MS = 800;
const LOCAL_CACHE_DEBOUNCE_MS = 400;
const STATS_SYNC_DEBOUNCE_MS = 250;

function getMostRecentTimestamp(currentTimestamp: string, nextTimestamp: string) {
  const currentTime = Date.parse(currentTimestamp);
  const nextTime = Date.parse(nextTimestamp);

  if (Number.isNaN(currentTime)) {
    return nextTimestamp;
  }

  if (Number.isNaN(nextTime)) {
    return currentTimestamp;
  }

  return nextTime >= currentTime ? nextTimestamp : currentTimestamp;
}

function isIncomingHydrationStale(
  currentTimestamp: string,
  incomingTimestamp: string,
) {
  const currentTime = Date.parse(currentTimestamp);
  const incomingTime = Date.parse(incomingTimestamp);

  return (
    !Number.isNaN(currentTime) &&
    (Number.isNaN(incomingTime) || incomingTime < currentTime)
  );
}

type UseDocumentDraftResult = {
  formattedUpdated: string;
  flushLatestDraft: () => Promise<void>;
  getLatestContent: () => string;
  getLatestTitle: () => string;
  handleEditorChange: (doc: Text) => void;
  handleTitleBlur: () => void;
  handleTitleChange: (nextTitle: string) => void;
  isDeleting: boolean;
  markDeleting: () => void;
  readingTime: number;
  resetDeletingState: () => void;
  shareEnabled: boolean;
  shareToken: string | null;
  title: string;
  updateShareState: (enabled: boolean, token: string | null, updatedAt: string) => void;
};

export type DraftSaveSnapshot = {
  content: string;
  title: string;
};

type DraftPageLifecycleOptions = {
  clearScheduledWork: () => void;
  isDeleting: () => boolean;
  saveLatestDraft: () => void;
  writeLocalCacheSnapshot: () => void;
};

export type DraftPageLifecycleHandlers = {
  handlePageHide: () => void;
  handleUnmount: () => void;
  handleVisibilityChange: (visibilityState: DocumentVisibilityState) => void;
};

/**
 * Captures the current editor refs before canceling debounced work. Calling the
 * IndexedDB writer synchronously here queues the durable write while the page
 * is still alive; network persistence remains a best-effort follow-up.
 */
export function createDraftPageLifecycleHandlers({
  clearScheduledWork,
  isDeleting,
  saveLatestDraft,
  writeLocalCacheSnapshot,
}: DraftPageLifecycleOptions): DraftPageLifecycleHandlers {
  const snapshotAndCancelScheduledWork = () => {
    const canPersist = !isDeleting();
    if (canPersist) {
      writeLocalCacheSnapshot();
    }
    clearScheduledWork();
    return canPersist;
  };

  const flushLeavingPage = () => {
    if (snapshotAndCancelScheduledWork()) {
      saveLatestDraft();
    }
  };

  return {
    handlePageHide: flushLeavingPage,
    handleUnmount() {
      snapshotAndCancelScheduledWork();
    },
    handleVisibilityChange(visibilityState) {
      if (visibilityState === "hidden") {
        flushLeavingPage();
      }
    },
  };
}

export function hasUnsavedDocumentChanges({
  cachedDraftIsDirty,
  latestContent,
  latestTitle,
  savedContent,
  savedTitle,
}: {
  cachedDraftIsDirty: boolean;
  latestContent: string;
  latestTitle: string;
  savedContent: string;
  savedTitle: string;
}) {
  return (
    cachedDraftIsDirty ||
    latestTitle !== savedTitle ||
    latestContent !== savedContent
  );
}

export function applyConfirmedShareUpdate(
  didEditSinceHydration: { current: boolean },
  applyUpdate: () => void,
) {
  didEditSinceHydration.current = true;
  applyUpdate();
}

export type DraftHydrationState = {
  content: string;
  isDeleting: boolean;
  savedContent: string;
  savedTitle: string;
  savedUpdatedAt: string;
  shareEnabled: boolean;
  shareToken: string | null;
  title: string;
  updatedAt: string;
};

export type DraftHydrationMutations = {
  content: boolean;
  share: boolean;
  title: boolean;
};

/**
 * Preserves fields changed in this editor while accepting authoritative
 * remote values and save baselines for untouched fields.
 */
export function reconcileDraftHydration(
  current: DraftHydrationState,
  incoming: EditorDocument,
  mutations: DraftHydrationMutations,
): DraftHydrationState {
  // Keep fields and their optimistic-concurrency timestamp from one coherent
  // snapshot. A load that started before a confirmed local mutation must not
  // reintroduce its older untouched fields under the newer local timestamp.
  if (isIncomingHydrationStale(current.savedUpdatedAt, incoming.updated_at)) {
    return current;
  }

  return {
    content: mutations.content ? current.content : incoming.content,
    isDeleting: current.isDeleting,
    savedContent: incoming.content,
    savedTitle: incoming.title,
    savedUpdatedAt: incoming.updated_at,
    shareEnabled: mutations.share
      ? current.shareEnabled
      : incoming.share_enabled,
    shareToken: mutations.share ? current.shareToken : incoming.share_token,
    title: mutations.title ? current.title : incoming.title,
    updatedAt: getMostRecentTimestamp(current.updatedAt, incoming.updated_at),
  };
}

export type InitialDraftPersistenceGate = {
  hasDeferredSave: boolean;
  isOpen: boolean;
};

export function createInitialDraftPersistenceGate(
  isOpen: boolean,
): InitialDraftPersistenceGate {
  return { hasDeferredSave: false, isOpen };
}

export function requestInitialDraftPersistence(
  gate: InitialDraftPersistenceGate,
) {
  if (gate.isOpen) {
    return true;
  }

  gate.hasDeferredSave = true;
  return false;
}

export function openInitialDraftPersistenceGate(
  gate: InitialDraftPersistenceGate,
) {
  const shouldFlushDeferredSave = gate.hasDeferredSave;
  gate.hasDeferredSave = false;
  gate.isOpen = true;
  return shouldFlushDeferredSave;
}

export function settleDraftSaveQueue(
  queue: { current: DraftSaveSnapshot | null },
  succeeded: boolean,
) {
  const queuedSave = queue.current;
  queue.current = null;
  return succeeded ? queuedSave : null;
}

export function scheduleFailedDraftSaveRetry(
  queue: { current: DraftSaveSnapshot | null },
  scheduleRetry: () => void,
) {
  if (queue.current === null) {
    return false;
  }

  queue.current = null;
  scheduleRetry();
  return true;
}

export function useDocumentDraft(
  initialDocument: EditorDocument,
  hasResolvedRemoteState: boolean,
): UseDocumentDraftResult {
  const [title, setTitle] = useState(initialDocument.title);
  const [contentForStats, setContentForStats] = useState(initialDocument.content);
  const [updatedAt, setUpdatedAt] = useState(initialDocument.updated_at);
  const [shareEnabled, setShareEnabled] = useState(initialDocument.share_enabled);
  const [shareToken, setShareToken] = useState(initialDocument.share_token);
  const [isDeleting, setIsDeleting] = useState(false);

  const saveTimeoutRef = useRef<number | null>(null);
  const localCacheTimeoutRef = useRef<number | null>(null);
  const statsSyncTimeoutRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const queuedSaveRef = useRef<DraftSaveSnapshot | null>(null);
  const scheduledWorkGenerationRef = useRef(0);
  const saveDraftRef = useRef<
    (nextTitle: string, nextContent: string) => Promise<boolean>
  >(() => Promise.resolve(false));
  const isDeletingRef = useRef(false);
  const didEditSinceHydrationRef = useRef(false);
  const didEditTitleSinceHydrationRef = useRef(false);
  const didEditContentSinceHydrationRef = useRef(false);
  const didUpdateShareSinceHydrationRef = useRef(false);
  const initialPersistenceGateRef = useRef(
    createInitialDraftPersistenceGate(
      hasResolvedRemoteState || initialDocument._dirty === true,
    ),
  );
  const cachedDraftIsDirtyRef = useRef(initialDocument._dirty === true);
  const latestTitleRef = useRef(initialDocument.title);
  const latestContentRef = useRef<Text | string>(initialDocument.content);
  const latestContentTextRef = useRef(initialDocument.content);
  const latestSerializedContentSourceRef = useRef<Text | string>(
    initialDocument.content,
  );
  const latestUpdatedAtRef = useRef(initialDocument.updated_at);
  const shareEnabledRef = useRef(initialDocument.share_enabled);
  const shareTokenRef = useRef(initialDocument.share_token);
  const lastSavedRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });
  const lastSavedUpdatedAtRef = useRef(initialDocument.updated_at);
  const deferredContent = useDeferredValue(contentForStats);

  const clearScheduledWork = useCallback(() => {
    scheduledWorkGenerationRef.current += 1;

    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
      localCacheTimeoutRef.current = null;
    }
    if (statsSyncTimeoutRef.current !== null) {
      window.clearTimeout(statsSyncTimeoutRef.current);
      statsSyncTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    latestTitleRef.current = title;
  }, [title]);

  useEffect(() => {
    shareEnabledRef.current = shareEnabled;
    shareTokenRef.current = shareToken;
  }, [shareEnabled, shareToken]);

  const getLatestContent = useCallback(() => {
    const latestContent = latestContentRef.current;

    if (latestSerializedContentSourceRef.current === latestContent) {
      return latestContentTextRef.current;
    }

    const latestContentText = readDocumentText(latestContent);
    latestSerializedContentSourceRef.current = latestContent;
    latestContentTextRef.current = latestContentText;
    return latestContentText;
  }, []);

  const getLatestTitle = useCallback(() => {
    return latestTitleRef.current;
  }, []);

  const scheduleLatestDraftSave = useCallback(
    (scheduledWorkGeneration = scheduledWorkGenerationRef.current) => {
      if (scheduledWorkGenerationRef.current !== scheduledWorkGeneration) {
        return;
      }

      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = window.setTimeout(() => {
        saveTimeoutRef.current = null;
        if (scheduledWorkGenerationRef.current !== scheduledWorkGeneration) {
          return;
        }

        void saveDraftRef.current(
          latestTitleRef.current,
          getLatestContent(),
        );
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [getLatestContent],
  );

  const scheduleStatsSync = useCallback(() => {
    if (statsSyncTimeoutRef.current !== null) {
      window.clearTimeout(statsSyncTimeoutRef.current);
    }

    statsSyncTimeoutRef.current = window.setTimeout(() => {
      statsSyncTimeoutRef.current = null;
      const nextContent = getLatestContent();
      startTransition(() => {
        setContentForStats((currentContent) =>
          currentContent === nextContent ? currentContent : nextContent,
        );
      });
    }, STATS_SYNC_DEBOUNCE_MS);
  }, [getLatestContent]);

  const persistLocalCacheSnapshot = useCallback(() => {
    if (isDeletingRef.current) {
      return Promise.resolve(false);
    }

    const latestContent = getLatestContent();
    const latestTitle = latestTitleRef.current;
    const isDirty = hasUnsavedDocumentChanges({
      cachedDraftIsDirty: cachedDraftIsDirtyRef.current,
      latestContent,
      latestTitle,
      savedContent: lastSavedRef.current.content,
      savedTitle: lastSavedRef.current.title,
    });
    const doc: CachedDocument = {
      id: initialDocument.id,
      owner: initialDocument.owner,
      title: latestTitle,
      content: latestContent,
      updated_at: latestUpdatedAtRef.current,
      share_enabled: shareEnabledRef.current,
      share_token: shareTokenRef.current,
      _localUpdatedAt: Date.now(),
      _dirty: isDirty,
    };

    return putCachedDocument(doc);
  }, [getLatestContent, initialDocument.id, initialDocument.owner]);

  const writeLocalCacheSnapshot = useCallback(() => {
    void persistLocalCacheSnapshot();
  }, [persistLocalCacheSnapshot]);

  const scheduleLocalCacheWrite = useCallback(() => {
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
    }

    localCacheTimeoutRef.current = window.setTimeout(() => {
      localCacheTimeoutRef.current = null;
      writeLocalCacheSnapshot();
    }, LOCAL_CACHE_DEBOUNCE_MS);
  }, [writeLocalCacheSnapshot]);

  const applyUpdatedAt = useCallback((nextUpdatedAt: string) => {
    const resolvedUpdatedAt = getMostRecentTimestamp(
      latestUpdatedAtRef.current,
      nextUpdatedAt,
    );

    latestUpdatedAtRef.current = resolvedUpdatedAt;
    setUpdatedAt((currentUpdatedAt) =>
      currentUpdatedAt === resolvedUpdatedAt ? currentUpdatedAt : resolvedUpdatedAt,
    );

    return resolvedUpdatedAt;
  }, []);

  useEffect(() => {
    if (
      isIncomingHydrationStale(
        lastSavedUpdatedAtRef.current,
        initialDocument.updated_at,
      )
    ) {
      return;
    }

    const mutations: DraftHydrationMutations = {
      content: didEditContentSinceHydrationRef.current,
      share: didUpdateShareSinceHydrationRef.current,
      title: didEditTitleSinceHydrationRef.current,
    };
    const reconciled = reconcileDraftHydration(
      {
        content: getLatestContent(),
        isDeleting: isDeletingRef.current,
        savedContent: lastSavedRef.current.content,
        savedTitle: lastSavedRef.current.title,
        savedUpdatedAt: lastSavedUpdatedAtRef.current,
        shareEnabled: shareEnabledRef.current,
        shareToken: shareTokenRef.current,
        title: latestTitleRef.current,
        updatedAt: latestUpdatedAtRef.current,
      },
      initialDocument,
      mutations,
    );

    if (!mutations.title) {
      latestTitleRef.current = reconciled.title;
      setTitle(reconciled.title);
    }

    if (!mutations.content) {
      latestContentRef.current = reconciled.content;
      latestContentTextRef.current = reconciled.content;
      latestSerializedContentSourceRef.current = reconciled.content;
      setContentForStats(reconciled.content);
    }

    if (!mutations.share) {
      shareEnabledRef.current = reconciled.shareEnabled;
      shareTokenRef.current = reconciled.shareToken;
      setShareEnabled(reconciled.shareEnabled);
      setShareToken(reconciled.shareToken);
    }

    latestUpdatedAtRef.current = reconciled.updatedAt;
    setUpdatedAt(reconciled.updatedAt);
    isDeletingRef.current = reconciled.isDeleting;
    setIsDeleting(reconciled.isDeleting);
    cachedDraftIsDirtyRef.current = initialDocument._dirty === true;
    lastSavedRef.current = {
      title: reconciled.savedTitle,
      content: reconciled.savedContent,
    };
    lastSavedUpdatedAtRef.current = reconciled.savedUpdatedAt;

    if (mutations.title || mutations.content || mutations.share) {
      scheduleLocalCacheWrite();
    }
  }, [getLatestContent, initialDocument, scheduleLocalCacheWrite]);

  const saveDraft = useCallback(
    async (nextTitle: string, nextContent: string) => {
      if (isDeletingRef.current) {
        return true;
      }

      if (!requestInitialDraftPersistence(initialPersistenceGateRef.current)) {
        return true;
      }

      if (
        !cachedDraftIsDirtyRef.current &&
        nextTitle === lastSavedRef.current.title &&
        nextContent === lastSavedRef.current.content
      ) {
        return true;
      }

      if (saveInFlightRef.current) {
        queuedSaveRef.current = {
          title: nextTitle,
          content: nextContent,
        };
        return true;
      }

      saveInFlightRef.current = true;
      const scheduledWorkGeneration = scheduledWorkGenerationRef.current;
      let shouldRetryQueuedSave = false;
      let titleToSave = nextTitle;
      let contentToSave = nextContent;

      try {
        while (true) {
          if (isDeletingRef.current) {
            return true;
          }

          const shareEnabledToSave = shareEnabledRef.current;
          const shareTokenToSave = shareTokenRef.current;
          let result;
          try {
            result = await persistDocumentSnapshot({
              id: initialDocument.id,
              owner: initialDocument.owner,
              title: titleToSave,
              content: contentToSave,
              share_enabled: shareEnabledToSave,
              share_token: shareTokenToSave,
              updated_at: latestUpdatedAtRef.current,
            });
          } catch {
            shouldRetryQueuedSave = true;
            return false;
          }

          if (!result.ok || !result.updatedAt) {
            shouldRetryQueuedSave = true;
            return false;
          }

          lastSavedRef.current = {
            title: titleToSave,
            content: contentToSave,
          };
          lastSavedUpdatedAtRef.current = result.updatedAt;
          cachedDraftIsDirtyRef.current = false;
          const resolvedUpdatedAt = applyUpdatedAt(result.updatedAt);

          if (
            resolvedUpdatedAt !== result.updatedAt ||
            shareEnabledRef.current !== shareEnabledToSave ||
            shareTokenRef.current !== shareTokenToSave
          ) {
            writeLocalCacheSnapshot();
          }

          const queuedSave = settleDraftSaveQueue(queuedSaveRef, true);
          if (!queuedSave) {
            return true;
          }

          if (
            queuedSave.title === lastSavedRef.current.title &&
            queuedSave.content === lastSavedRef.current.content
          ) {
            return true;
          }

          titleToSave = queuedSave.title;
          contentToSave = queuedSave.content;
        }
      } finally {
        saveInFlightRef.current = false;
        if (shouldRetryQueuedSave) {
          if (
            scheduledWorkGenerationRef.current === scheduledWorkGeneration
          ) {
            scheduleFailedDraftSaveRetry(queuedSaveRef, () => {
              scheduleLatestDraftSave(scheduledWorkGeneration);
            });
          } else {
            settleDraftSaveQueue(queuedSaveRef, false);
          }
        }
      }
    },
    [
      applyUpdatedAt,
      initialDocument.id,
      initialDocument.owner,
      scheduleLatestDraftSave,
      writeLocalCacheSnapshot,
    ],
  );

  useEffect(() => {
    saveDraftRef.current = saveDraft;
  }, [saveDraft]);

  useEffect(() => {
    if (!hasResolvedRemoteState) {
      return;
    }

    const hadDeferredSave = openInitialDraftPersistenceGate(
      initialPersistenceGateRef.current,
    );
    const latestTitle = latestTitleRef.current;
    const latestContent = getLatestContent();
    const hasUnsavedChanges = hasUnsavedDocumentChanges({
      cachedDraftIsDirty: cachedDraftIsDirtyRef.current,
      latestContent,
      latestTitle,
      savedContent: lastSavedRef.current.content,
      savedTitle: lastSavedRef.current.title,
    });

    if (
      hadDeferredSave ||
      (didEditSinceHydrationRef.current && hasUnsavedChanges)
    ) {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      void saveDraft(latestTitle, latestContent);
    }
  }, [getLatestContent, hasResolvedRemoteState, saveDraft]);

  useEffect(() => {
    if (!didEditSinceHydrationRef.current) {
      return;
    }

    scheduleLatestDraftSave();
  }, [scheduleLatestDraftSave, title]);

  useEffect(() => {
    if (!didEditSinceHydrationRef.current) {
      return;
    }

    scheduleLocalCacheWrite();
  }, [scheduleLocalCacheWrite, title, shareEnabled, shareToken]);

  useEffect(() => {
    const saveLatestDraft = () => {
      const latestTitle = latestTitleRef.current;
      const latestContent = getLatestContent();
      const isDirty = hasUnsavedDocumentChanges({
        cachedDraftIsDirty: cachedDraftIsDirtyRef.current,
        latestContent,
        latestTitle,
        savedContent: lastSavedRef.current.content,
        savedTitle: lastSavedRef.current.title,
      });

      if (!isDirty) {
        return;
      }

      void saveDraft(latestTitle, latestContent);
    };
    const lifecycleHandlers = createDraftPageLifecycleHandlers({
      clearScheduledWork,
      isDeleting: () => isDeletingRef.current,
      saveLatestDraft,
      writeLocalCacheSnapshot: () => {
        if (didEditSinceHydrationRef.current) {
          writeLocalCacheSnapshot();
        }
      },
    });
    const handleVisibilityChange = () => {
      lifecycleHandlers.handleVisibilityChange(document.visibilityState);
    };

    window.addEventListener("pagehide", lifecycleHandlers.handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", lifecycleHandlers.handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      lifecycleHandlers.handleUnmount();
    };
  }, [
    clearScheduledWork,
    getLatestContent,
    saveDraft,
    writeLocalCacheSnapshot,
  ]);

  const readingTime = useMemo(() => {
    return getReadingTimeFromText(deferredContent);
  }, [deferredContent]);

  const formattedUpdated = useMemo(() => {
    return formatRelativeTimestamp(updatedAt);
  }, [updatedAt]);

  const flushLatestDraft = useCallback(async () => {
    if (isDeletingRef.current) {
      return;
    }

    clearScheduledWork();
    const cacheWrite = persistLocalCacheSnapshot();
    void saveDraft(latestTitleRef.current, getLatestContent());
    await cacheWrite;
  }, [clearScheduledWork, getLatestContent, persistLocalCacheSnapshot, saveDraft]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    didEditSinceHydrationRef.current = true;
    didEditTitleSinceHydrationRef.current = true;
    latestTitleRef.current = nextTitle;
    setTitle(nextTitle);
  }, []);

  const handleTitleBlur = useCallback(() => {
    if (latestTitleRef.current.trim()) {
      return;
    }

    latestTitleRef.current = "Untitled";
    setTitle("Untitled");
  }, []);

  const handleEditorChange = useCallback(
    (doc: Text) => {
      didEditSinceHydrationRef.current = true;
      didEditContentSinceHydrationRef.current = true;
      latestContentRef.current = doc;
      scheduleStatsSync();
      scheduleLocalCacheWrite();
      scheduleLatestDraftSave();
    },
    [scheduleLatestDraftSave, scheduleLocalCacheWrite, scheduleStatsSync],
  );

  const updateShareState = useCallback(
    (enabled: boolean, token: string | null, updatedAt: string) => {
      applyConfirmedShareUpdate(didEditSinceHydrationRef, () => {
        didUpdateShareSinceHydrationRef.current = true;
        shareEnabledRef.current = enabled;
        shareTokenRef.current = token;
        applyUpdatedAt(updatedAt);
        setShareEnabled(enabled);
        setShareToken(token);
        writeLocalCacheSnapshot();
      });
    },
    [applyUpdatedAt, writeLocalCacheSnapshot],
  );

  const markDeleting = useCallback(() => {
    isDeletingRef.current = true;
    setIsDeleting(true);
    queuedSaveRef.current = null;
    clearScheduledWork();
  }, [clearScheduledWork]);

  const resetDeletingState = useCallback(() => {
    isDeletingRef.current = false;
    setIsDeleting(false);
  }, []);

  return {
    formattedUpdated,
    flushLatestDraft,
    getLatestContent,
    getLatestTitle,
    handleEditorChange,
    handleTitleBlur,
    handleTitleChange,
    isDeleting,
    markDeleting,
    readingTime,
    resetDeletingState,
    shareEnabled,
    shareToken,
    title,
    updateShareState,
  };
}
