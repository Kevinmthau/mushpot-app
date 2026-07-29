import { describe, expect, it, vi } from "vitest";

import {
  createDraftPageLifecycleHandlers,
  hasUnsavedDocumentChanges,
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
