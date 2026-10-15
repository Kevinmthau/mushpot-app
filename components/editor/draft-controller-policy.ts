import type { EditorDocument } from "@/components/editor/editor-types";
import {
  parseDocumentContentFormat,
  type DocumentContentFormat,
} from "@/lib/page-document";

export function getMostRecentTimestamp(
  currentTimestamp: string,
  nextTimestamp: string,
) {
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

export function isIncomingHydrationStale(
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
  latestContentFormat,
  latestTitle,
  savedContent,
  savedContentFormat,
  savedTitle,
}: {
  cachedDraftIsDirty: boolean;
  latestContent: string;
  latestContentFormat: DocumentContentFormat;
  latestTitle: string;
  savedContent: string;
  savedContentFormat: DocumentContentFormat;
  savedTitle: string;
}) {
  return (
    cachedDraftIsDirty ||
    latestTitle !== savedTitle ||
    latestContent !== savedContent ||
    latestContentFormat !== savedContentFormat
  );
}

export type DraftHydrationState = {
  content: string;
  contentFormat: DocumentContentFormat;
  isDeleting: boolean;
  savedContent: string;
  savedContentFormat: DocumentContentFormat;
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
    contentFormat: mutations.content
      ? current.contentFormat
      : parseDocumentContentFormat(incoming.content_format),
    isDeleting: current.isDeleting,
    savedContent: incoming.content,
    savedContentFormat: parseDocumentContentFormat(incoming.content_format),
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
