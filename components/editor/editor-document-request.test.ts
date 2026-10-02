import { describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  createEditorDocumentRequests,
  type EditorRemoteResult,
} from "@/components/editor/editor-document-request";
import type { DocumentCacheWriteToken } from "@/lib/doc-cache";
import { createDocumentWriteSession } from "@/lib/document-write-coordinator";

const DOCUMENT = {
  id: "doc", owner: "owner", title: "Title", content: "Body",
  updated_at: "2026-10-01T12:00:00Z", share_enabled: false, share_token: null,
};
const SUCCESS: EditorRemoteResult = { document: DOCUMENT, error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function setup() {
  let time = 0;
  let token: DocumentCacheWriteToken | null = { owner: "owner", generation: 1 };
  const query = vi.fn(async (): Promise<EditorRemoteResult> => SUCCESS);
  const canReuse = vi.fn(async () => true);
  const session = createDocumentWriteSession("owner");
  const requests = createEditorDocumentRequests({
    canReuse, getToken: () => token, now: () => time, query,
  });
  return {
    requests, query, canReuse, session,
    setTime: (value: number) => { time = value; },
    setToken: (value: DocumentCacheWriteToken | null) => { token = value; },
  };
}

describe("intent document requests", () => {
  it("shares a warm in-flight query with editor loading without writing the cache", async () => {
    const { requests, query, canReuse, session } = setup();
    const remote = deferred<EditorRemoteResult>();
    query.mockReturnValueOnce(remote.promise);
    expect(requests.warm("doc", session)).toBe(true);
    expect(requests.warm("doc", session)).toBe(false);
    const loading = requests.load("doc", session);
    remote.resolve(SUCCESS);
    await expect(loading).resolves.toEqual(SUCCESS);
    expect(query).toHaveBeenCalledOnce();
    expect(canReuse).toHaveBeenCalledWith(
      "doc", { owner: "owner", generation: 1 }, DOCUMENT.updated_at, 0,
    );
  });

  it("shares ordinary in-flight loads during effect replay", async () => {
    const { requests, query, session } = setup();
    const remote = deferred<EditorRemoteResult>();
    query.mockReturnValueOnce(remote.promise);
    const first = requests.load("doc", session);
    const second = requests.load("doc", session);
    remote.resolve(SUCCESS);
    await expect(Promise.all([first, second])).resolves.toEqual([SUCCESS, SUCCESS]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("allows cold-start cache activation to finish while a fresh query is running", async () => {
    const { requests, query, session, setToken } = setup();
    const remote = deferred<EditorRemoteResult>();
    setToken(null);
    expect(requests.warm("doc", session)).toBe(false);
    query.mockReturnValueOnce(remote.promise);
    const loading = requests.load("doc", session);
    setToken({ owner: "owner", generation: 1 });
    remote.resolve(SUCCESS);
    await expect(loading).resolves.toEqual(SUCCESS);
  });

  it("refetches a warm response that expired before navigation", async () => {
    const { requests, query, session, setTime } = setup();
    requests.warm("doc", session);
    await Promise.resolve();
    setTime(5000);
    await expect(requests.load("doc", session)).resolves.toEqual(SUCCESS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not publish a slow warm response that expires while being awaited", async () => {
    const { requests, query, session, setTime } = setup();
    const remote = deferred<EditorRemoteResult>();
    query.mockReturnValueOnce(remote.promise);
    requests.warm("doc", session);
    const loading = requests.load("doc", session);
    setTime(5000);
    query.mockResolvedValueOnce({ document: { ...DOCUMENT, content: "Fresh" }, error: null });
    remote.resolve(SUCCESS);
    await expect(loading).resolves.toMatchObject({ document: { content: "Fresh" } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("never shares warm rows between retired and replacement sessions for the same owner", async () => {
    const { requests, query, session } = setup();
    const old = deferred<EditorRemoteResult>();
    query.mockReturnValueOnce(old.promise);
    requests.warm("doc", session);
    const oldLoading = requests.load("doc", session);
    session.deactivate();
    const replacement = createDocumentWriteSession("owner");
    query.mockResolvedValueOnce({ document: { ...DOCUMENT, content: "Replacement" }, error: null });
    await expect(requests.load("doc", replacement)).resolves.toMatchObject({
      document: { content: "Replacement" },
    });
    old.resolve(SUCCESS);
    await expect(oldLoading).resolves.toMatchObject({ document: null });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refetches after the cache generation changes", async () => {
    const { requests, query, session, setToken } = setup();
    requests.warm("doc", session);
    await Promise.resolve();
    setToken({ owner: "owner", generation: 2 });
    await requests.load("doc", session);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a tombstoned row or a persistently revoked cache generation", async () => {
    const { requests, query, canReuse, session } = setup();
    requests.warm("doc", session);
    await Promise.resolve();
    canReuse.mockResolvedValue(false);
    query.mockResolvedValueOnce({ document: null, error: null });
    await expect(requests.load("doc", session)).resolves.toEqual({ document: null, error: null });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps a confirmed save made after warmup when the document is opened", async () => {
    vi.resetModules();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    try {
      const cache = await import("@/lib/doc-cache");
      const { loadEditorDocument } = await import("@/components/editor/use-editor-document");
      await cache.activateDocumentCacheForOwner("owner");
      const token = cache.getDocumentCacheWriteToken("owner")!;
      const latest = {
        ...DOCUMENT,
        content: "Confirmed after warmup",
        updated_at: "2026-10-01T12:00:01Z",
        share_enabled: true,
        share_token: "new-share-token",
        _dirty: false,
        _localUpdatedAt: 101,
      };
      const query = vi.fn(async (): Promise<EditorRemoteResult> => SUCCESS);
      const session = createDocumentWriteSession("owner");
      const requests = createEditorDocumentRequests({
        canReuse: cache.canReuseDocumentResponse,
        getToken: cache.getDocumentCacheWriteToken,
        now: () => 100,
        query,
      });
      requests.warm("doc", session);
      await Promise.resolve();
      await cache.putCachedDocument(latest, token);
      query.mockResolvedValueOnce({ document: latest, error: null });
      const onResolved = vi.fn();
      await loadEditorDocument({
        isCurrent: () => true,
        loadCache: async () => ({
          document: await cache.getCachedDocumentForOwner("doc", "owner", token), token,
        }),
        loadRemote: () => requests.load("doc", session),
        onCache: vi.fn(),
        onResolved,
        reconcileRemote: (row) => cache.reconcileCachedDocumentWithServer(row, token),
      });
      expect(query).toHaveBeenCalledTimes(2);
      expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({
        document: expect.objectContaining({ content: latest.content, share_token: latest.share_token }),
      }));
      expect(await cache.getCachedDocumentForOwner("doc", "owner", token)).toMatchObject({
        content: latest.content, share_token: latest.share_token,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rechecks session retirement and expiry after asynchronous cache validation", async () => {
    const { requests, query, canReuse, session } = setup();
    const validation = deferred<boolean>();
    canReuse.mockReturnValue(validation.promise);
    requests.warm("doc", session);
    const loading = requests.load("doc", session);
    await Promise.resolve();
    await Promise.resolve();
    session.deactivate();
    validation.resolve(true);
    await expect(loading).resolves.toMatchObject({ document: null });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([null, "offline"])("does not retain a warm missing/error result (%s)", async (error) => {
    const { requests, query, session } = setup();
    query.mockResolvedValueOnce({ document: null, error });
    requests.warm("doc", session);
    await Promise.resolve();
    await expect(requests.load("doc", session)).resolves.toEqual(SUCCESS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("bounds concurrent warmups and starts per window, including slow expired requests", async () => {
    const { requests, query, session, setTime } = setup();
    const remote = deferred<EditorRemoteResult>();
    query.mockReturnValue(remote.promise);
    expect(requests.warm("a", session)).toBe(true);
    expect(requests.warm("b", session)).toBe(true);
    expect(requests.warm("c", session)).toBe(false);
    setTime(5000);
    expect(requests.warm("c", session)).toBe(false);
    remote.resolve(SUCCESS);
    await Promise.resolve();
    expect(requests.warm("c", session)).toBe(true);
    await Promise.resolve();
    expect(requests.warm("d", session)).toBe(true);
    await Promise.resolve();
    expect(requests.warm("e", session)).toBe(true);
    await Promise.resolve();
    expect(requests.warm("f", session)).toBe(false);
  });
});
