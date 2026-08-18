import { describe, expect, it, vi } from "vitest";

import {
  loadEditorDocument,
  type EditorDocumentResolution,
} from "@/components/editor/use-editor-document";
import type { EditorDocument } from "@/components/editor/editor-types";
import type { DocumentCacheWriteToken } from "@/lib/doc-cache";

const OWNER = "owner-a";
const TOKEN: DocumentCacheWriteToken = { generation: 7, owner: OWNER };

function buildDocument(
  overrides: Partial<EditorDocument> = {},
): EditorDocument {
  return {
    id: "document-a",
    owner: OWNER,
    title: "Draft",
    content: "Server content",
    updated_at: "2026-08-17T12:00:00.000Z",
    share_enabled: false,
    share_token: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("editor document loading", () => {
  it("overlaps remote work, validates cache first, and resolves only after reconciliation", async () => {
    const cachedDocument = buildDocument({
      _dirty: false,
      _localUpdatedAt: 200,
      content: "Cached content",
    });
    const serverDocument = buildDocument({
      content: "Older server content",
    });
    const cache = deferred<{
      document: EditorDocument;
      token: DocumentCacheWriteToken;
    }>();
    const remote = deferred<{
      document: EditorDocument;
      error: null;
    }>();
    const reconciliation = deferred<EditorDocument>();
    const reconciledDocument = buildDocument({
      content: "Reconciled server content",
    });
    const onCache = vi.fn();
    const onResolved = vi.fn<(resolution: EditorDocumentResolution) => void>();
    const loadCache = vi.fn(() => cache.promise);
    const loadRemote = vi.fn(() => remote.promise);
    const reconcileRemote = vi.fn(() => reconciliation.promise);

    const completion = loadEditorDocument({
      isCurrent: () => true,
      loadCache,
      loadRemote,
      onCache,
      onResolved,
      reconcileRemote,
    });

    expect(loadRemote).toHaveBeenCalledOnce();
    expect(loadCache).toHaveBeenCalledOnce();

    remote.resolve({ document: serverDocument, error: null });
    await Promise.resolve();
    expect(onCache).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();

    cache.resolve({ document: cachedDocument, token: TOKEN });
    await Promise.resolve();
    await Promise.resolve();

    expect(onCache).toHaveBeenCalledWith(cachedDocument);
    expect(reconcileRemote).toHaveBeenCalledWith(
      serverDocument,
      TOKEN,
      expect.any(Function),
    );
    expect(onResolved).not.toHaveBeenCalled();

    reconciliation.resolve(reconciledDocument);
    await completion;

    expect(onResolved).toHaveBeenCalledWith({
      document: reconciledDocument,
      error: null,
      notFound: false,
    });
  });

  it("preserves an initially dirty cache snapshot without remote reconciliation", async () => {
    const dirtyDraft = buildDocument({
      _dirty: true,
      _localUpdatedAt: 200,
      content: "Unsynced local edit",
    });
    const remote = deferred<{
      document: EditorDocument;
      error: null;
    }>();
    const onCache = vi.fn();
    const onResolved = vi.fn();
    const reconcileRemote = vi.fn(async (document: EditorDocument) => document);

    const completion = loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: dirtyDraft, token: TOKEN }),
      loadRemote: () => remote.promise,
      onCache,
      onResolved,
      reconcileRemote,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onCache).toHaveBeenCalledWith(dirtyDraft);

    remote.resolve({
      document: buildDocument({ content: "Remote content" }),
      error: null,
    });
    await completion;

    expect(reconcileRemote).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({
      document: dirtyDraft,
      error: null,
      notFound: false,
    });
  });

  it("preserves a validated cache document when the remote query fails", async () => {
    const cachedDocument = buildDocument({ content: "Offline copy" });
    const onResolved = vi.fn();
    const reconcileRemote = vi.fn();

    await loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: cachedDocument, token: TOKEN }),
      loadRemote: async () => ({ document: null, error: "offline" }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote,
    });

    expect(reconcileRemote).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({
      document: cachedDocument,
      error: null,
      notFound: false,
    });
  });

  it("preserves a dirty cached draft when the remote row is missing", async () => {
    const cachedDocument = buildDocument({
      _dirty: true,
      content: "Unsynced cached copy",
    });
    const onResolved = vi.fn();

    await loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: cachedDocument, token: TOKEN }),
      loadRemote: async () => ({ document: null, error: null }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote: vi.fn(),
    });

    expect(onResolved).toHaveBeenCalledWith({
      document: cachedDocument,
      error: null,
      notFound: false,
    });
  });

  it("does not keep a clean cached ghost when the remote row is missing", async () => {
    const cachedDocument = buildDocument({ content: "Stale clean copy" });
    const onResolved = vi.fn();

    await loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: cachedDocument, token: TOKEN }),
      loadRemote: async () => ({ document: null, error: null }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote: vi.fn(),
    });

    expect(onResolved).toHaveBeenCalledWith({
      document: null,
      error: null,
      notFound: true,
    });
  });

  it("keeps a clean cache document that becomes locally edited before remote not-found", async () => {
    const cachedDocument = buildDocument({ content: "Initially clean cache" });
    const remote = deferred<{ document: null; error: null }>();
    let hasLocalEdits = false;
    const onResolved = vi.fn();

    const completion = loadEditorDocument({
      hasLocalEdits: () => hasLocalEdits,
      isCurrent: () => true,
      loadCache: async () => ({ document: cachedDocument, token: TOKEN }),
      loadRemote: () => remote.promise,
      onCache: () => {
        hasLocalEdits = true;
      },
      onResolved,
      reconcileRemote: vi.fn(),
    });

    await Promise.resolve();
    remote.resolve({ document: null, error: null });
    await completion;

    expect(onResolved).toHaveBeenCalledWith({
      document: cachedDocument,
      error: null,
      notFound: false,
    });
  });

  it("publishes the raw remote row for field merging after a live edit dirties the cache", async () => {
    const cleanCache = buildDocument({
      content: "Cached body",
      title: "Cached title",
    });
    const remoteDocument = buildDocument({
      content: "Newer remote body",
      title: "Remote title",
    });
    let hasLocalEdits = false;
    const onResolved = vi.fn();
    const reconcileRemote = vi.fn(async (document: EditorDocument) => document);

    await loadEditorDocument({
      hasLocalEdits: () => hasLocalEdits,
      isCurrent: () => true,
      loadCache: async () => ({ document: cleanCache, token: TOKEN }),
      loadRemote: async () => ({ document: remoteDocument, error: null }),
      onCache: () => {
        hasLocalEdits = true;
      },
      onResolved,
      reconcileRemote,
    });

    expect(reconcileRemote).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith({
      document: remoteDocument,
      error: null,
      notFound: false,
    });
  });

  it("revokes an in-progress reconciliation cache write when a live edit begins", async () => {
    const cleanCache = buildDocument({ content: "Cached body" });
    const remoteDocument = buildDocument({ content: "Remote body" });
    const reconciliation = deferred<EditorDocument>();
    let hasLocalEdits = false;
    let canWrite: (() => boolean) | undefined;
    const onResolved = vi.fn();
    const reconcileRemote = vi.fn(
      async (
        _document: EditorDocument,
        _token: DocumentCacheWriteToken | null,
        writeGuard: () => boolean,
      ) => {
        canWrite = writeGuard;
        return reconciliation.promise;
      },
    );

    const completion = loadEditorDocument({
      hasLocalEdits: () => hasLocalEdits,
      isCurrent: () => true,
      loadCache: async () => ({ document: cleanCache, token: TOKEN }),
      loadRemote: async () => ({ document: remoteDocument, error: null }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote,
    });

    await vi.waitFor(() => {
      expect(canWrite).toBeTypeOf("function");
    });
    expect(canWrite?.()).toBe(true);

    hasLocalEdits = true;
    expect(canWrite?.()).toBe(false);
    reconciliation.resolve(remoteDocument);
    await completion;

    expect(onResolved).toHaveBeenCalledWith({
      document: remoteDocument,
      error: null,
      notFound: false,
    });
  });

  it("keeps an already-dirty offline draft opaque during remote reconciliation", async () => {
    const dirtyOfflineDraft = buildDocument({
      _dirty: true,
      content: "Offline body",
      title: "Offline title",
    });
    const remoteDocument = buildDocument({
      content: "Remote body",
      title: "Remote title",
    });
    const onResolved = vi.fn();

    await loadEditorDocument({
      hasLocalEdits: () => true,
      isCurrent: () => true,
      loadCache: async () => ({
        document: dirtyOfflineDraft,
        token: TOKEN,
      }),
      loadRemote: async () => ({ document: remoteDocument, error: null }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote: async () => dirtyOfflineDraft,
    });

    expect(onResolved).toHaveBeenCalledWith({
      document: dirtyOfflineDraft,
      error: null,
      notFound: false,
    });
  });

  it("reports not found only after both cache and remote resolve empty", async () => {
    const onResolved = vi.fn();

    await loadEditorDocument({
      isCurrent: () => true,
      loadCache: async () => ({ document: null, token: TOKEN }),
      loadRemote: async () => ({ document: null, error: null }),
      onCache: vi.fn(),
      onResolved,
      reconcileRemote: vi.fn(),
    });

    expect(onResolved).toHaveBeenCalledWith({
      document: null,
      error: null,
      notFound: true,
    });
  });

  it("suppresses a completed old load after the owner/request changes", async () => {
    const cache = deferred<{
      document: EditorDocument;
      token: DocumentCacheWriteToken;
    }>();
    let isCurrent = true;
    const onCache = vi.fn();
    const onResolved = vi.fn();

    const completion = loadEditorDocument({
      isCurrent: () => isCurrent,
      loadCache: () => cache.promise,
      loadRemote: async () => ({
        document: buildDocument(),
        error: null,
      }),
      onCache,
      onResolved,
      reconcileRemote: vi.fn(async (document) => document),
    });

    isCurrent = false;
    cache.resolve({ document: buildDocument(), token: TOKEN });
    await completion;

    expect(onCache).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });
});
