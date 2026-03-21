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

import { readDocumentText } from "@/components/editor/editor-appearance";
import type { EditorDocument } from "@/components/editor/editor-types";
import { putCachedDocument, type CachedDocument } from "@/lib/doc-cache";
import { getReadingTimeFromText } from "@/lib/document-stats";
import { persistDocumentSnapshot } from "@/lib/document-sync";
import { formatRelativeTimestamp } from "@/lib/format-relative-time";

const AUTOSAVE_DEBOUNCE_MS = 800;
const LOCAL_CACHE_DEBOUNCE_MS = 400;
const STATS_SYNC_DEBOUNCE_MS = 250;

type UseDocumentDraftResult = {
  formattedUpdated: string;
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

export function useDocumentDraft(
  initialDocument: EditorDocument,
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
  const queuedSaveRef = useRef<{ title: string; content: string } | null>(null);
  const isDeletingRef = useRef(false);
  const didEditSinceHydrationRef = useRef(false);
  const latestTitleRef = useRef(initialDocument.title);
  const latestContentRef = useRef<Text | string>(initialDocument.content);
  const latestUpdatedAtRef = useRef(initialDocument.updated_at);
  const shareEnabledRef = useRef(initialDocument.share_enabled);
  const shareTokenRef = useRef(initialDocument.share_token);
  const lastSavedRef = useRef({
    title: initialDocument.title,
    content: initialDocument.content,
  });
  const deferredContent = useDeferredValue(contentForStats);

  const clearScheduledWork = useCallback(() => {
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
    if (didEditSinceHydrationRef.current) {
      return;
    }

    setTitle(initialDocument.title);
    setContentForStats(initialDocument.content);
    setUpdatedAt(initialDocument.updated_at);
    setShareEnabled(initialDocument.share_enabled);
    setShareToken(initialDocument.share_token);
    setIsDeleting(false);
    latestTitleRef.current = initialDocument.title;
    latestContentRef.current = initialDocument.content;
    latestUpdatedAtRef.current = initialDocument.updated_at;
    shareEnabledRef.current = initialDocument.share_enabled;
    shareTokenRef.current = initialDocument.share_token;
    isDeletingRef.current = false;
    lastSavedRef.current = {
      title: initialDocument.title,
      content: initialDocument.content,
    };
  }, [initialDocument]);

  useEffect(() => {
    latestTitleRef.current = title;
  }, [title]);

  useEffect(() => {
    shareEnabledRef.current = shareEnabled;
    shareTokenRef.current = shareToken;
  }, [shareEnabled, shareToken]);

  const getLatestContent = useCallback(() => {
    return readDocumentText(latestContentRef.current);
  }, []);

  const getLatestTitle = useCallback(() => {
    return latestTitleRef.current;
  }, []);

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

  const scheduleLocalCacheWrite = useCallback(() => {
    if (localCacheTimeoutRef.current !== null) {
      window.clearTimeout(localCacheTimeoutRef.current);
    }

    localCacheTimeoutRef.current = window.setTimeout(() => {
      localCacheTimeoutRef.current = null;

      if (isDeletingRef.current) {
        return;
      }

      const latestContent = getLatestContent();
      const latestTitle = latestTitleRef.current;
      const isDirty =
        latestTitle !== lastSavedRef.current.title ||
        latestContent !== lastSavedRef.current.content;
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
      void putCachedDocument(doc);
    }, LOCAL_CACHE_DEBOUNCE_MS);
  }, [getLatestContent, initialDocument.id, initialDocument.owner]);

  const saveDraft = useCallback(
    async (nextTitle: string, nextContent: string) => {
      if (isDeletingRef.current) {
        return true;
      }

      if (
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
      let titleToSave = nextTitle;
      let contentToSave = nextContent;

      try {
        while (true) {
          if (isDeletingRef.current) {
            return true;
          }

          const result = await persistDocumentSnapshot({
            id: initialDocument.id,
            owner: initialDocument.owner,
            title: titleToSave,
            content: contentToSave,
            share_enabled: shareEnabledRef.current,
            share_token: shareTokenRef.current,
          });

          if (!result.ok || !result.updatedAt) {
            return false;
          }

          lastSavedRef.current = {
            title: titleToSave,
            content: contentToSave,
          };
          latestUpdatedAtRef.current = result.updatedAt;
          setUpdatedAt(result.updatedAt);

          const queuedSave = queuedSaveRef.current;
          if (!queuedSave) {
            return true;
          }

          queuedSaveRef.current = null;
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
      }
    },
    [initialDocument.id, initialDocument.owner],
  );

  useEffect(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      void saveDraft(latestTitleRef.current, getLatestContent());
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [getLatestContent, saveDraft, title]);

  useEffect(() => {
    scheduleLocalCacheWrite();
  }, [scheduleLocalCacheWrite, title, shareEnabled, shareToken]);

  useEffect(() => {
    const flushPendingDraft = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }

      const latestTitle = latestTitleRef.current;
      const latestContent = getLatestContent();
      const isDirty =
        latestTitle !== lastSavedRef.current.title ||
        latestContent !== lastSavedRef.current.content;

      if (!isDirty) {
        return;
      }

      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      void saveDraft(latestTitle, latestContent);
    };

    document.addEventListener("visibilitychange", flushPendingDraft);
    return () => {
      document.removeEventListener("visibilitychange", flushPendingDraft);
    };
  }, [getLatestContent, saveDraft]);

  useEffect(() => {
    return () => {
      clearScheduledWork();
    };
  }, [clearScheduledWork]);

  const readingTime = useMemo(() => {
    return getReadingTimeFromText(deferredContent);
  }, [deferredContent]);

  const formattedUpdated = useMemo(() => {
    return formatRelativeTimestamp(updatedAt);
  }, [updatedAt]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    didEditSinceHydrationRef.current = true;
    setTitle(nextTitle);
  }, []);

  const handleTitleBlur = useCallback(() => {
    if (!latestTitleRef.current.trim()) {
      setTitle("Untitled");
    }
  }, []);

  const handleEditorChange = useCallback(
    (doc: Text) => {
      didEditSinceHydrationRef.current = true;
      latestContentRef.current = doc;
      scheduleStatsSync();
      scheduleLocalCacheWrite();
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(() => {
        saveTimeoutRef.current = null;
        void saveDraft(latestTitleRef.current, getLatestContent());
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [getLatestContent, saveDraft, scheduleLocalCacheWrite, scheduleStatsSync],
  );

  const updateShareState = useCallback((
    enabled: boolean,
    token: string | null,
    updatedAt: string,
  ) => {
    shareEnabledRef.current = enabled;
    shareTokenRef.current = token;
    latestUpdatedAtRef.current = updatedAt;
    setShareEnabled(enabled);
    setShareToken(token);
    setUpdatedAt(updatedAt);
  }, []);

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
