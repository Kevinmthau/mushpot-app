import { describe, expect, it, vi } from "vitest";

import {
  applyConfirmedShareUpdate,
  createInitialDraftPersistenceGate,
  createDraftPageLifecycleHandlers,
  hasUnsavedDocumentChanges,
  openInitialDraftPersistenceGate,
  reconcileDraftHydration,
  requestInitialDraftPersistence,
  scheduleFailedDraftSaveRetry,
  settleDraftSaveQueue,
} from "@/components/editor/use-document-draft";

function createLifecycle(isDeleting = false) {
  const calls: string[] = [];
  const clearScheduledWork = vi.fn(() => {
    calls.push("clear");
  });
  const saveLatestDraft = vi.fn(() => {
    calls.push("save");
  });
  const writeLocalCacheSnapshot = vi.fn(() => {
    calls.push("snapshot");
  });
  const handlers = createDraftPageLifecycleHandlers({
    clearScheduledWork,
    isDeleting: () => isDeleting,
    saveLatestDraft,
    writeLocalCacheSnapshot,
  });

  return {
    calls,
    clearScheduledWork,
    handlers,
    saveLatestDraft,
    writeLocalCacheSnapshot,
  };
}

describe("draft page lifecycle", () => {
  it("consumes a queued snapshot while scheduling a retry after failure", () => {
    const events: string[] = [];
    const queue = {
      current: {
        content: "Older queued body",
        title: "Older queued title",
      },
    };

    expect(
      scheduleFailedDraftSaveRetry(queue, () => {
        events.push("retry");
      }),
    ).toBe(true);
    expect(queue.current).toBeNull();
    expect(events).toEqual(["retry"]);

    expect(
      scheduleFailedDraftSaveRetry(queue, () => {
        events.push("unexpected-retry");
      }),
    ).toBe(false);
    expect(events).toEqual(["retry"]);

    const newerSnapshot = {
      content: "Newest body",
      title: "Newest title",
    };
    queue.current = newerSnapshot;

    expect(settleDraftSaveQueue(queue, true)).toBe(newerSnapshot);
    expect(queue.current).toBeNull();
  });

  it("defers a clean-cache autosave until the remote body has merged", () => {
    const gate = createInitialDraftPersistenceGate(false);
    const persistedSnapshots: Array<{ content: string; title: string }> = [];

    expect(requestInitialDraftPersistence(gate)).toBe(false);
    expect(persistedSnapshots).toEqual([]);

    const reconciled = reconcileDraftHydration(
      {
        content: "Cached body",
        isDeleting: false,
        savedContent: "Cached body",
        savedTitle: "Cached title",
        savedUpdatedAt: "2026-08-17T12:00:00.000Z",
        shareEnabled: false,
        shareToken: null,
        title: "Locally edited title",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        id: "document-a",
        owner: "owner-a",
        title: "Remote title",
        content: "Newer remote body",
        updated_at: "2026-08-17T13:00:00.000Z",
        share_enabled: false,
        share_token: null,
      },
      { content: false, share: false, title: true },
    );

    expect(openInitialDraftPersistenceGate(gate)).toBe(true);
    if (requestInitialDraftPersistence(gate)) {
      persistedSnapshots.push({
        content: reconciled.content,
        title: reconciled.title,
      });
    }

    expect(persistedSnapshots).toEqual([
      {
        content: "Newer remote body",
        title: "Locally edited title",
      },
    ]);
  });

  it("does not gate a pre-existing offline-dirty draft", () => {
    const gate = createInitialDraftPersistenceGate(true);

    expect(requestInitialDraftPersistence(gate)).toBe(true);
  });

  it("merges a late remote body into the save baseline after a local title edit", () => {
    const reconciled = reconcileDraftHydration(
      {
        content: "Cached body",
        isDeleting: false,
        savedContent: "Cached body",
        savedTitle: "Cached title",
        savedUpdatedAt: "2026-08-17T12:00:00.000Z",
        shareEnabled: false,
        shareToken: null,
        title: "Locally edited title",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        id: "document-a",
        owner: "owner-a",
        title: "Remote title",
        content: "Newer remote body",
        updated_at: "2026-08-17T13:00:00.000Z",
        share_enabled: false,
        share_token: null,
      },
      { content: false, share: false, title: true },
    );

    expect(reconciled).toMatchObject({
      content: "Newer remote body",
      savedContent: "Newer remote body",
      savedTitle: "Remote title",
      title: "Locally edited title",
    });
    expect(
      hasUnsavedDocumentChanges({
        cachedDraftIsDirty: false,
        latestContent: reconciled.content,
        latestTitle: reconciled.title,
        savedContent: reconciled.savedContent,
        savedTitle: reconciled.savedTitle,
      }),
    ).toBe(true);
  });

  it("keeps a newer confirmed snapshot coherent when older hydration follows a title mutation", () => {
    const reconciled = reconcileDraftHydration(
      {
        content: "Newly saved local body",
        isDeleting: false,
        savedContent: "Newly saved local body",
        savedTitle: "Locally edited title",
        savedUpdatedAt: "2026-08-17T14:00:00.000Z",
        shareEnabled: false,
        shareToken: null,
        title: "Locally edited title",
        updatedAt: "2026-08-17T14:00:00.000Z",
      },
      {
        id: "document-a",
        owner: "owner-a",
        title: "Stale remote title",
        content: "Stale remote body",
        updated_at: "2026-08-17T13:00:00.000Z",
        share_enabled: false,
        share_token: null,
      },
      { content: false, share: false, title: true },
    );

    expect(reconciled).toMatchObject({
      content: "Newly saved local body",
      savedContent: "Newly saved local body",
      savedTitle: "Locally edited title",
      savedUpdatedAt: "2026-08-17T14:00:00.000Z",
      title: "Locally edited title",
      updatedAt: "2026-08-17T14:00:00.000Z",
    });
    expect(
      hasUnsavedDocumentChanges({
        cachedDraftIsDirty: false,
        latestContent: reconciled.content,
        latestTitle: reconciled.title,
        savedContent: reconciled.savedContent,
        savedTitle: reconciled.savedTitle,
      }),
    ).toBe(false);
  });

  it("keeps an edit-then-revert dirty against a differing remote baseline", () => {
    const reconciled = reconcileDraftHydration(
      {
        content: "Cached body",
        isDeleting: false,
        savedContent: "Cached body",
        savedTitle: "Cached title",
        savedUpdatedAt: "2026-08-17T12:00:00.000Z",
        shareEnabled: false,
        shareToken: null,
        title: "Cached title",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
      {
        id: "document-a",
        owner: "owner-a",
        title: "Different remote title",
        content: "Cached body",
        updated_at: "2026-08-17T13:00:00.000Z",
        share_enabled: false,
        share_token: null,
      },
      { content: false, share: false, title: true },
    );

    expect(reconciled).toMatchObject({
      savedTitle: "Different remote title",
      title: "Cached title",
    });
    expect(
      hasUnsavedDocumentChanges({
        cachedDraftIsDirty: false,
        latestContent: reconciled.content,
        latestTitle: reconciled.title,
        savedContent: reconciled.savedContent,
        savedTitle: reconciled.savedTitle,
      }),
    ).toBe(true);
  });

  it("preserves confirmed share state and active deletion while hydrating untouched fields", () => {
    const reconciled = reconcileDraftHydration(
      {
        content: "Cached body",
        isDeleting: true,
        savedContent: "Cached body",
        savedTitle: "Cached title",
        savedUpdatedAt: "2026-08-17T12:00:00.000Z",
        shareEnabled: true,
        shareToken: "confirmed-token",
        title: "Cached title",
        updatedAt: "2026-08-17T14:00:00.000Z",
      },
      {
        id: "document-a",
        owner: "owner-a",
        title: "Remote title",
        content: "Newer remote body",
        updated_at: "2026-08-17T13:00:00.000Z",
        share_enabled: false,
        share_token: null,
      },
      { content: false, share: true, title: false },
    );

    expect(reconciled).toMatchObject({
      content: "Newer remote body",
      isDeleting: true,
      savedContent: "Newer remote body",
      savedTitle: "Remote title",
      shareEnabled: true,
      shareToken: "confirmed-token",
      title: "Remote title",
      updatedAt: "2026-08-17T14:00:00.000Z",
    });
  });

  it("protects a confirmed share update from later hydration replacement", () => {
    const didEditSinceHydration = { current: false };
    const observedGuardValues: boolean[] = [];

    applyConfirmedShareUpdate(didEditSinceHydration, () => {
      observedGuardValues.push(didEditSinceHydration.current);
    });

    expect(observedGuardValues).toEqual([true]);
    expect(didEditSinceHydration.current).toBe(true);
  });

  it("keeps a hydrated cached draft dirty until a server save succeeds", () => {
    expect(
      hasUnsavedDocumentChanges({
        cachedDraftIsDirty: true,
        latestContent: "Offline content",
        latestTitle: "Offline title",
        savedContent: "Offline content",
        savedTitle: "Offline title",
      }),
    ).toBe(true);
  });

  it("treats an unchanged clean document as clean", () => {
    expect(
      hasUnsavedDocumentChanges({
        cachedDraftIsDirty: false,
        latestContent: "Saved content",
        latestTitle: "Saved title",
        savedContent: "Saved content",
        savedTitle: "Saved title",
      }),
    ).toBe(false);
  });

  it("snapshots before canceling an unmount-before-debounce timer", () => {
    const lifecycle = createLifecycle();

    lifecycle.handlers.handleUnmount();

    expect(lifecycle.calls).toEqual(["snapshot", "clear"]);
    expect(lifecycle.saveLatestDraft).not.toHaveBeenCalled();
  });

  it("snapshots before canceling timers and attempting save on pagehide", () => {
    const lifecycle = createLifecycle();

    lifecycle.handlers.handlePageHide();

    expect(lifecycle.calls).toEqual(["snapshot", "clear", "save"]);
  });

  it("uses the same durable-first ordering when visibility becomes hidden", () => {
    const lifecycle = createLifecycle();

    lifecycle.handlers.handleVisibilityChange("visible");
    expect(lifecycle.calls).toEqual([]);

    lifecycle.handlers.handleVisibilityChange("hidden");
    expect(lifecycle.calls).toEqual(["snapshot", "clear", "save"]);
  });

  it("cancels timers without recreating a cache row after deletion starts", () => {
    const lifecycle = createLifecycle(true);

    lifecycle.handlers.handlePageHide();
    lifecycle.handlers.handleUnmount();

    expect(lifecycle.clearScheduledWork).toHaveBeenCalledTimes(2);
    expect(lifecycle.writeLocalCacheSnapshot).not.toHaveBeenCalled();
    expect(lifecycle.saveLatestDraft).not.toHaveBeenCalled();
  });
});
