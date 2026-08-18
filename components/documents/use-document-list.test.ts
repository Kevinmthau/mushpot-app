import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DocumentListLoading } from "@/components/documents/document-list-loading";
import { shouldShowDocumentListLoading } from "@/components/documents/documents-page-client";
import {
  beginDocumentListRefresh,
  loadDocumentListRefresh,
  loadInitialDocumentList,
  reduceDocumentListLoadState,
  selectDocumentListView,
  type OwnedDocumentListState,
} from "@/components/documents/use-document-list";
import type { DocumentCacheWriteToken } from "@/lib/doc-cache";
import type { DocumentListItem } from "@/lib/documents";

const OWNER = "owner-a";
const TOKEN: DocumentCacheWriteToken = { generation: 4, owner: OWNER };
const CACHED_DOCUMENT: DocumentListItem = {
  id: "cached",
  title: "Cached draft",
  updated_at: "2026-08-17T12:00:00.000Z",
};
const REMOTE_DOCUMENT: DocumentListItem = {
  id: "remote",
  title: "Remote document",
  updated_at: "2026-08-17T13:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function initialState(): OwnedDocumentListState {
  return {
    documents: [],
    error: null,
    isLoading: false,
    owner: null,
  };
}

describe("initial document list loading", () => {
  it("starts remote work before cache resolution and applies reconciled remote state after cache", async () => {
    const cache = deferred<{
      documents: DocumentListItem[];
      token: DocumentCacheWriteToken;
    }>();
    const remote = deferred<{
      documents: DocumentListItem[];
      error: null;
    }>();
    const events: string[] = [];
    const loadCache = vi.fn(() => cache.promise);
    const loadRemote = vi.fn(() => {
      events.push("remote-started");
      return remote.promise;
    });
    const syncRemote = vi.fn(() => {
      events.push("remote-synced");
      return [REMOTE_DOCUMENT];
    });

    const completion = loadInitialDocumentList({
      isCurrent: () => true,
      loadCache,
      loadRemote,
      onCache: () => events.push("cache-applied"),
      onRemoteError: () => events.push("remote-error"),
      onRemoteSuccess: () => events.push("remote-applied"),
      syncRemote,
    });

    expect(loadRemote).toHaveBeenCalledOnce();
    expect(loadCache).toHaveBeenCalledOnce();

    remote.resolve({ documents: [REMOTE_DOCUMENT], error: null });
    await Promise.resolve();
    expect(events).toEqual(["remote-started"]);

    cache.resolve({ documents: [CACHED_DOCUMENT], token: TOKEN });
    await completion;

    expect(events).toEqual([
      "remote-started",
      "cache-applied",
      "remote-synced",
      "remote-applied",
    ]);
    expect(syncRemote).toHaveBeenCalledWith([REMOTE_DOCUMENT], TOKEN);
  });

  it("publishes a newer dirty cached title instead of a stale remote prefix", async () => {
    const staleRemoteDocument = {
      ...REMOTE_DOCUMENT,
      id: "presentation",
      title: "Present",
    };
    const dirtyCachedDocument = {
      ...staleRemoteDocument,
      title: "Presentation outline",
    };
    const onRemoteSuccess = vi.fn();

    await loadInitialDocumentList({
      isCurrent: () => true,
      loadCache: async () => ({
        documents: [dirtyCachedDocument],
        token: TOKEN,
      }),
      loadRemote: async () => ({
        documents: [staleRemoteDocument],
        error: null,
      }),
      onCache: vi.fn(),
      onRemoteError: vi.fn(),
      onRemoteSuccess,
      syncRemote: async () => [dirtyCachedDocument],
    });

    expect(onRemoteSuccess).toHaveBeenCalledWith([dirtyCachedDocument]);
  });

  it("falls back to remote rows when cache reconciliation fails", async () => {
    const onRemoteSuccess = vi.fn();

    await loadInitialDocumentList({
      isCurrent: () => true,
      loadCache: async () => ({ documents: [], token: TOKEN }),
      loadRemote: async () => ({
        documents: [REMOTE_DOCUMENT],
        error: null,
      }),
      onCache: vi.fn(),
      onRemoteError: vi.fn(),
      onRemoteSuccess,
      syncRemote: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    expect(onRemoteSuccess).toHaveBeenCalledWith([REMOTE_DOCUMENT]);
  });

  it("does not publish reconciliation that finishes after cancellation", async () => {
    const reconciliation = deferred<DocumentListItem[] | null>();
    let markSyncStarted!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    let isCurrent = true;
    const onRemoteSuccess = vi.fn();

    const completion = loadInitialDocumentList({
      isCurrent: () => isCurrent,
      loadCache: async () => ({ documents: [], token: TOKEN }),
      loadRemote: async () => ({
        documents: [REMOTE_DOCUMENT],
        error: null,
      }),
      onCache: vi.fn(),
      onRemoteError: vi.fn(),
      onRemoteSuccess,
      syncRemote: () => {
        markSyncStarted();
        return reconciliation.promise;
      },
    });

    await syncStarted;
    isCurrent = false;
    reconciliation.resolve([REMOTE_DOCUMENT]);
    await completion;

    expect(onRemoteSuccess).not.toHaveBeenCalled();
  });

  it("suppresses cache, remote, and sync commits after a newer request wins", async () => {
    const cache = deferred<{
      documents: DocumentListItem[];
      token: DocumentCacheWriteToken;
    }>();
    const remote = deferred<{
      documents: DocumentListItem[];
      error: null;
    }>();
    let isCurrent = true;
    const onCache = vi.fn();
    const onRemoteSuccess = vi.fn();
    const syncRemote = vi.fn();

    const completion = loadInitialDocumentList({
      isCurrent: () => isCurrent,
      loadCache: () => cache.promise,
      loadRemote: () => remote.promise,
      onCache,
      onRemoteError: vi.fn(),
      onRemoteSuccess,
      syncRemote,
    });

    isCurrent = false;
    remote.resolve({ documents: [REMOTE_DOCUMENT], error: null });
    cache.resolve({ documents: [CACHED_DOCUMENT], token: TOKEN });
    await completion;

    expect(onCache).not.toHaveBeenCalled();
    expect(onRemoteSuccess).not.toHaveBeenCalled();
    expect(syncRemote).not.toHaveBeenCalled();
  });

  it("settles remote failures without discarding an available cache result", async () => {
    const events: string[] = [];

    await loadInitialDocumentList({
      isCurrent: () => true,
      loadCache: async () => ({
        documents: [CACHED_DOCUMENT],
        token: TOKEN,
      }),
      loadRemote: async () => {
        throw new Error("offline");
      },
      onCache: () => events.push("cache-applied"),
      onRemoteError: () => events.push("remote-error"),
      onRemoteSuccess: () => events.push("remote-applied"),
      syncRemote: () => {
        events.push("remote-synced");
        return null;
      },
    });

    expect(events).toEqual(["cache-applied", "remote-error"]);
  });

  it("syncs a refresh that supersedes an initial load during cache activation", async () => {
    const activation = deferred<void>();
    const initialRemote = deferred<{
      documents: DocumentListItem[];
      error: null;
    }>();
    const refreshRemote = deferred<{
      documents: DocumentListItem[];
      error: null;
    }>();
    const getCacheWriteToken = vi.fn(() => TOKEN);
    const initialSync = vi.fn(() => [CACHED_DOCUMENT]);
    const refreshSuccess = vi.fn();
    const refreshSync = vi.fn(() => [CACHED_DOCUMENT]);
    let requestId = 1;

    const initialCompletion = loadInitialDocumentList({
      isCurrent: () => requestId === 1,
      loadCache: async () => {
        await activation.promise;
        return { documents: [], token: TOKEN };
      },
      loadRemote: () => initialRemote.promise,
      onCache: vi.fn(),
      onRemoteError: vi.fn(),
      onRemoteSuccess: vi.fn(),
      syncRemote: initialSync,
    });

    requestId = 2;
    const refreshCompletion = loadDocumentListRefresh({
      activateCache: () => activation.promise,
      getCacheWriteToken,
      isCurrent: () => requestId === 2,
      loadRemote: () => refreshRemote.promise,
      onRemoteError: vi.fn(),
      onRemoteSuccess: refreshSuccess,
      syncRemote: refreshSync,
    });

    initialRemote.resolve({ documents: [CACHED_DOCUMENT], error: null });
    refreshRemote.resolve({ documents: [REMOTE_DOCUMENT], error: null });
    await Promise.resolve();

    expect(getCacheWriteToken).not.toHaveBeenCalled();
    expect(refreshSuccess).not.toHaveBeenCalled();
    expect(refreshSync).not.toHaveBeenCalled();

    activation.resolve();
    await Promise.all([initialCompletion, refreshCompletion]);

    expect(initialSync).not.toHaveBeenCalled();
    expect(getCacheWriteToken).toHaveBeenCalledOnce();
    expect(refreshSuccess).toHaveBeenCalledWith([CACHED_DOCUMENT]);
    expect(refreshSync).toHaveBeenCalledWith([REMOTE_DOCUMENT], TOKEN);
  });
});

describe("document list loading state", () => {
  it("keeps an empty cache loading until remote state resolves", () => {
    const loading = reduceDocumentListLoadState(initialState(), {
      owner: OWNER,
      type: "begin",
    });
    const afterEmptyCache = reduceDocumentListLoadState(loading, {
      documents: [],
      owner: OWNER,
      type: "cache",
    });

    expect(afterEmptyCache).toEqual(loading);
    expect(afterEmptyCache.isLoading).toBe(true);
  });

  it("reveals a non-empty cache while remote reconciliation continues", () => {
    const loading = reduceDocumentListLoadState(initialState(), {
      owner: OWNER,
      type: "begin",
    });
    const cached = reduceDocumentListLoadState(loading, {
      documents: [CACHED_DOCUMENT],
      owner: OWNER,
      type: "cache",
    });

    expect(cached.documents).toEqual([CACHED_DOCUMENT]);
    expect(cached.isLoading).toBe(false);
  });

  it("ends loading with an honest empty remote list", () => {
    const loading = reduceDocumentListLoadState(initialState(), {
      owner: OWNER,
      type: "begin",
    });
    const resolved = reduceDocumentListLoadState(loading, {
      documents: [],
      owner: OWNER,
      type: "remote-success",
    });

    expect(resolved.documents).toEqual([]);
    expect(resolved.error).toBeNull();
    expect(resolved.isLoading).toBe(false);
  });

  it("shows remote errors only when no cached documents are visible", () => {
    const loading = reduceDocumentListLoadState(initialState(), {
      owner: OWNER,
      type: "begin",
    });
    const withoutCache = reduceDocumentListLoadState(loading, {
      error: "offline",
      owner: OWNER,
      type: "remote-error",
    });
    const withCache = reduceDocumentListLoadState(
      { ...loading, documents: [CACHED_DOCUMENT] },
      {
        error: "offline",
        owner: OWNER,
        type: "remote-error",
      },
    );

    expect(withoutCache).toMatchObject({ error: "offline", isLoading: false });
    expect(withCache).toMatchObject({
      documents: [CACHED_DOCUMENT],
      error: null,
      isLoading: false,
    });
  });

  it("ignores results belonging to a previous owner", () => {
    const current = {
      documents: [REMOTE_DOCUMENT],
      error: null,
      isLoading: false,
      owner: "owner-b",
    } satisfies OwnedDocumentListState;

    expect(
      reduceDocumentListLoadState(current, {
        documents: [CACHED_DOCUMENT],
        owner: OWNER,
        type: "cache",
      }),
    ).toBe(current);
  });

  it("keeps an empty list visibly loading during a manual retry", () => {
    const current = reduceDocumentListLoadState(initialState(), {
      owner: OWNER,
      type: "begin",
    });
    const failed = reduceDocumentListLoadState(current, {
      error: "offline",
      owner: OWNER,
      type: "remote-error",
    });
    const retrying = beginDocumentListRefresh(failed, OWNER);

    expect(retrying).toMatchObject({
      documents: [],
      error: null,
      isLoading: true,
      owner: OWNER,
    });
  });

  it("keeps cached documents visible during a manual refresh", () => {
    const current = {
      documents: [CACHED_DOCUMENT],
      error: "offline",
      isLoading: false,
      owner: OWNER,
    } satisfies OwnedDocumentListState;

    expect(beginDocumentListRefresh(current, OWNER)).toMatchObject({
      documents: [CACHED_DOCUMENT],
      error: null,
      isLoading: false,
    });
  });

  it("maps an owner mismatch to an isolated loading view", () => {
    const state = {
      documents: [CACHED_DOCUMENT],
      error: "previous owner error",
      isLoading: false,
      owner: "owner-b",
    } satisfies OwnedDocumentListState;

    expect(selectDocumentListView(state, OWNER)).toEqual({
      documents: [],
      error: null,
      isLoading: true,
    });
  });
});

describe("document list loading UI", () => {
  it("renders an accessible status instead of a blank or false-empty list", () => {
    const html = renderToStaticMarkup(createElement(DocumentListLoading));

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading documents"');
    expect(html).toContain("Loading documents…");
  });

  it("selects loading rows only while an empty list is unresolved", () => {
    expect(shouldShowDocumentListLoading([], true)).toBe(true);
    expect(shouldShowDocumentListLoading([], false)).toBe(false);
    expect(shouldShowDocumentListLoading([CACHED_DOCUMENT], true)).toBe(false);
  });
});
