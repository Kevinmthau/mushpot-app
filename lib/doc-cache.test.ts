import {
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedDocument, CachedDocumentRecord } from "@/lib/doc-cache";

const OWNER = "owner-a";

function buildDocument(
  overrides: Partial<CachedDocument> = {},
): CachedDocument {
  return {
    id: "document-a",
    owner: OWNER,
    title: "Draft",
    content: "Private content",
    updated_at: "2026-07-17T12:00:00.000Z",
    share_enabled: false,
    share_token: null,
    ...overrides,
  };
}

async function loadDocumentCache() {
  return import("@/lib/doc-cache");
}

function waitForRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedPreviousCache(
  documents: (CachedDocument | CachedDocumentRecord)[],
  version = 2,
) {
  const openRequest = indexedDB.open("mushpot", version);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    const documentStore = database.createObjectStore("documents", {
      keyPath: "id",
    });
    documentStore.createIndex("updated_at", "updated_at");
    documentStore.createIndex("owner", "owner");
    documentStore.createIndex("owner_updated_at", ["owner", "updated_at"]);
    documentStore.createIndex("dirty", "_dirtyKey");
    database.createObjectStore("meta", { keyPath: "key" });
  };

  const database = await waitForRequest(openRequest);
  const transaction = database.transaction("documents", "readwrite");
  for (const document of documents) {
    transaction.objectStore("documents").put(document);
  }
  await waitForTransaction(transaction);
  database.close();
}

describe("owner-scoped document cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
    Object.assign(globalThis, {
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    });
  });

  it("rejects reads, writes, and deletes until the owner is activated", async () => {
    const cache = await loadDocumentCache();

    expect(await cache.putCachedDocument(buildDocument())).toBe(false);
    expect(
      await cache.getCachedDocumentRecordForOwner("document-a", OWNER),
    ).toBeNull();
    expect(await cache.getCachedDocumentListForOwner(OWNER)).toEqual([]);
    expect(await cache.deleteCachedDocument("document-a", OWNER)).toBe(false);
  });

  it("stores complete editor records with an explicit discriminator", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);

    expect(
      await cache.putCachedDocument(buildDocument({ _dirty: true })),
    ).toBe(true);

    expect(
      await cache.getCachedDocumentForOwner("document-a", OWNER),
    ).toEqual(
      expect.objectContaining({
        _dirty: true,
        _dirtyKey: 1,
        content: "Private content",
        kind: "complete",
        owner: OWNER,
      }),
    );
  });

  it("keeps list-only rows as metadata that the editor cannot open offline", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);

    await cache.syncDocumentList(
      [
        {
          id: "metadata-only",
          title: "From the server list",
          updated_at: "2026-07-18T12:00:00.000Z",
        },
      ],
      OWNER,
    );

    expect(
      await cache.getCachedDocumentRecordForOwner("metadata-only", OWNER),
    ).toEqual({
      id: "metadata-only",
      kind: "metadata",
      owner: OWNER,
      title: "From the server list",
      updated_at: "2026-07-18T12:00:00.000Z",
    });
    expect(
      await cache.getCachedDocumentForOwner("metadata-only", OWNER),
    ).toBeNull();
    expect(await cache.getCachedDocumentListForOwner(OWNER)).toEqual([
      {
        id: "metadata-only",
        title: "From the server list",
        updated_at: "2026-07-18T12:00:00.000Z",
      },
    ]);
  });

  it("reads only this owner's dirty bodies and removes saved drafts from the lookup", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner("other-owner");
    await cache.putCachedDocument(buildDocument({ id: "dirty", _dirty: true }));
    await cache.putCachedDocument(buildDocument({
      id: "clean",
      content: "x".repeat(100_000),
    }));
    await cache.putCachedDocument(buildDocument({
      id: "other-dirty",
      owner: "other-owner",
      _dirty: true,
    }));

    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    expect(await cache.getDirtyDocuments(OWNER)).toEqual([
      expect.objectContaining({ id: "dirty", owner: OWNER, _dirty: true }),
    ]);
    // Check the actual records read from IndexedDB, before the cache's filters.
    expect(getAll).toHaveBeenCalledOnce();
    expect(getAll.mock.results[0].value.result).toEqual([
      expect.objectContaining({ id: "dirty", owner: OWNER }),
    ]);

    await cache.putCachedDocument(buildDocument({ id: "dirty", _dirty: false }));
    getAll.mockClear();
    expect(await cache.getDirtyDocuments(OWNER)).toEqual([]);
    expect(getAll.mock.results[0].value.result).toEqual([]);
  });

  it("writes only changed list rows and leaves unchanged complete bodies untouched", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const complete = buildDocument({ content: "x".repeat(100_000) });
    await cache.putCachedDocument(complete);
    const rows = [
      { id: complete.id, title: complete.title, updated_at: complete.updated_at },
      { id: "metadata", title: "Metadata", updated_at: complete.updated_at },
    ];
    await cache.syncDocumentList(rows, OWNER);

    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const documentWrites = () => put.mock.calls.filter((_, index) => {
      const store = put.mock.contexts[index];
      return store instanceof IDBObjectStore && store.name === "documents";
    });
    expect(await cache.syncDocumentList(rows, OWNER)).toHaveLength(2);
    expect(documentWrites()).toEqual([]);

    const renamedRows = rows.map((row) => row.id === "metadata"
      ? { ...row, title: "Renamed" }
      : row);
    await cache.syncDocumentList(renamedRows, OWNER);
    expect(documentWrites()).toEqual([
      [expect.objectContaining({ id: "metadata", title: "Renamed" })],
    ]);
    expect(await cache.getCachedDocumentForOwner(complete.id, OWNER)).toEqual(
      expect.objectContaining(complete),
    );
  });

  it("updates list metadata without changing the complete snapshot or its version", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(buildDocument());

    const reconciledDocuments = await cache.syncDocumentList(
      [
        {
          id: "document-a",
          title: "Renamed remotely",
          updated_at: "2026-07-19T12:00:00.000Z",
        },
      ],
      OWNER,
    );

    expect(
      await cache.getCachedDocumentForOwner("document-a", OWNER),
    ).toEqual(
      expect.objectContaining({
        content: "Private content",
        kind: "complete",
        title: "Draft",
        updated_at: "2026-07-17T12:00:00.000Z",
        _listMetadata: {
          title: "Renamed remotely",
          updated_at: "2026-07-19T12:00:00.000Z",
        },
      }),
    );
    expect(await cache.getCachedDocumentListForOwner(OWNER)).toEqual(reconciledDocuments);
    expect(reconciledDocuments).toEqual([
      {
        id: "document-a",
        title: "Renamed remotely",
        updated_at: "2026-07-19T12:00:00.000Z",
      },
    ]);
  });


  it("keeps fresher list metadata through offline edits, stale refreshes, and reloads", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const snapshot = buildDocument();
    await cache.putCachedDocument(snapshot);
    await cache.putCachedDocument(buildDocument({ id: "other", updated_at: "2026-07-18T12:00:00.000Z" }));
    const rows = [
      { id: snapshot.id, title: "Remote title", updated_at: "2026-07-19T12:00:00.000Z" },
      { id: "other", title: "Other", updated_at: "2026-07-18T12:00:00.000Z" },
    ];
    await cache.syncDocumentList(rows, OWNER);
    expect((await cache.getCachedDocumentListForOwner(OWNER))[0]).toEqual(rows[0]);
    await cache.putCachedDocument({ ...snapshot, title: "Local draft", content: "Offline edits", _dirty: true });
    await cache.syncDocumentList(rows.map((row) => row.id === snapshot.id ? { ...row, title: "Stale", updated_at: snapshot.updated_at } : row), OWNER);
    expect((await cache.getCachedDocumentListForOwner(OWNER))[0]).toEqual({ ...rows[0], title: "Local draft" });
    expect(await cache.getCachedDocumentForOwner(snapshot.id, OWNER)).toMatchObject({
      title: "Local draft", content: "Offline edits", updated_at: snapshot.updated_at,
    });
    vi.resetModules();
    const reloadedCache = await loadDocumentCache();
    await reloadedCache.activateDocumentCacheForOwner(OWNER);
    expect((await reloadedCache.getCachedDocumentListForOwner(OWNER))[0]).toEqual({ ...rows[0], title: "Local draft" });
  });

  it("replaces list display with a newer complete server snapshot", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(buildDocument());
    await cache.syncDocumentList([{ id: "document-a", title: "List title", updated_at: "2026-07-18T12:00:00.000Z" }], OWNER);
    const latest = buildDocument({ title: "Newest title", content: "Newest body", updated_at: "2026-07-19T12:00:00.000Z" });
    await cache.reconcileCachedDocumentWithServer(latest);
    expect(await cache.getCachedDocumentForOwner(latest.id, OWNER)).toMatchObject(latest);
    expect(await cache.getCachedDocumentListForOwner(OWNER)).toEqual([{ id: latest.id, title: latest.title, updated_at: latest.updated_at }]);
  });

  it("does not let an older save completion overwrite a newer local draft", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        content: "Newer local edit",
        _dirty: true,
        _localUpdatedAt: 200,
      }),
    );

    expect(
      await cache.putCachedDocument(
        buildDocument({
          content: "Older saved edit",
          _dirty: false,
          _localUpdatedAt: 100,
        }),
      ),
    ).toBe(false);

    expect(
      await cache.getCachedDocumentForOwner("document-a", OWNER),
    ).toEqual(
      expect.objectContaining({
        content: "Newer local edit",
        _dirty: true,
        _localUpdatedAt: 200,
      }),
    );
  });

  it("tombstones a deletion against delayed writes and stale list responses", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(buildDocument());
    const deletionGeneration = cache.getDocumentCacheWriteToken(OWNER);

    expect(
      await cache.deleteCachedDocument(
        "document-a",
        OWNER,
        deletionGeneration,
      ),
    ).toBe(true);
    expect(
      await cache.putCachedDocument(
        buildDocument({
          content: "Delayed save completion",
          _dirty: false,
        }),
        deletionGeneration,
      ),
    ).toBe(false);

    const reconciledDocuments = await cache.syncDocumentList(
      [
        {
          id: "document-a",
          title: "Stale server row",
          updated_at: "2026-07-20T12:00:00.000Z",
        },
      ],
      OWNER,
      deletionGeneration,
    );

    expect(
      await cache.getCachedDocumentRecordForOwner(
        "document-a",
        OWNER,
        deletionGeneration,
      ),
    ).toBeNull();
    expect(
      await cache.getCachedDocumentListForOwner(OWNER, deletionGeneration),
    ).toEqual([]);
    expect(reconciledDocuments).toEqual([]);
  });

  it("scopes deletion tombstones to the active owner generation", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const deletedGeneration = cache.getDocumentCacheWriteToken(OWNER);

    expect(
      await cache.deleteCachedDocument(
        "document-a",
        OWNER,
        deletedGeneration,
      ),
    ).toBe(true);
    expect(
      await cache.putCachedDocument(buildDocument(), deletedGeneration),
    ).toBe(false);

    await cache.deactivateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(OWNER);
    const currentGeneration = cache.getDocumentCacheWriteToken(OWNER);

    expect(currentGeneration?.generation).not.toBe(
      deletedGeneration?.generation,
    );
    expect(
      await cache.putCachedDocument(buildDocument(), deletedGeneration),
    ).toBe(false);
    expect(
      await cache.putCachedDocument(buildDocument(), currentGeneration),
    ).toBe(true);
  });

  it("deactivation hides all rows, purges clean data, and quarantines dirty drafts", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({ id: "dirty", _dirty: true }),
    );
    await cache.putCachedDocument(
      buildDocument({ id: "clean", _dirty: false }),
    );
    const oldToken = cache.getDocumentCacheWriteToken(OWNER);

    await cache.deactivateDocumentCacheForOwner(OWNER);

    expect(cache.getDocumentCacheWriteToken(OWNER)).toBeNull();
    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER, oldToken),
    ).toBeNull();
    expect(await cache.getCachedDocumentListForOwner(OWNER, oldToken)).toEqual(
      [],
    );

    await cache.activateDocumentCacheForOwner(OWNER);

    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER),
    ).toEqual(expect.objectContaining({ _dirty: true }));
    expect(
      await cache.getCachedDocumentRecordForOwner("clean", OWNER),
    ).toBeNull();
  });

  it("a full purge removes dirty drafts as well as clean records", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({ id: "dirty", _dirty: true }),
    );
    await cache.putCachedDocument(buildDocument({ id: "clean" }));

    await cache.purgeDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(OWNER);

    expect(
      await cache.getCachedDocumentRecordForOwner("dirty", OWNER),
    ).toBeNull();
    expect(
      await cache.getCachedDocumentRecordForOwner("clean", OWNER),
    ).toBeNull();
  });

  it("rejects stale-generation reads, writes, and deletes after reactivation", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({ id: "dirty", _dirty: true }),
    );
    const staleToken = cache.getDocumentCacheWriteToken(OWNER);

    await cache.deactivateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(OWNER);
    const currentToken = cache.getDocumentCacheWriteToken(OWNER);

    expect(currentToken?.generation).not.toBe(staleToken?.generation);
    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER, staleToken),
    ).toBeNull();
    expect(
      await cache.putCachedDocument(
        buildDocument({ id: "stale-write" }),
        staleToken,
      ),
    ).toBe(false);
    expect(
      await cache.deleteCachedDocument("dirty", OWNER, staleToken),
    ).toBe(false);
    await expect(
      cache.getDirtyDocuments(OWNER, staleToken),
    ).rejects.toThrow("document cache changed");
    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER, currentToken),
    ).not.toBeNull();
  });

  it("atomically lets a purge win over work from an older generation", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const oldToken = cache.getDocumentCacheWriteToken(OWNER);

    const queuedWrite = cache.putCachedDocument(buildDocument(), oldToken);
    const purge = cache.purgeDocumentCacheForOwner(OWNER);
    await Promise.all([queuedWrite, purge]);
    await cache.activateDocumentCacheForOwner(OWNER);

    expect(
      await cache.getCachedDocumentRecordForOwner("document-a", OWNER),
    ).toBeNull();
  });

  it("does not expose or delete another owner's records", async () => {
    const cache = await loadDocumentCache();
    const otherOwner = "owner-b";
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(otherOwner);
    await cache.putCachedDocument(buildDocument());
    await cache.putCachedDocument(
      buildDocument({ id: "document-b", owner: otherOwner }),
    );

    expect(
      await cache.getCachedDocumentRecordForOwner("document-b", OWNER),
    ).toBeNull();
    expect(
      await cache.deleteCachedDocument("document-b", OWNER),
    ).toBe(false);

    await cache.purgeDocumentCacheForOwner(OWNER);

    expect(
      await cache.getCachedDocumentForOwner("document-b", otherOwner),
    ).not.toBeNull();
  });

  it("rejects stale list reconciliation after owner reactivation", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({ id: "dirty", _dirty: true }),
    );
    const staleToken = cache.getDocumentCacheWriteToken(OWNER);

    await cache.deactivateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(buildDocument({ id: "current" }));

    await cache.syncDocumentList(
      [
        {
          id: "stale-server-row",
          title: "Stale",
          updated_at: "2026-08-17T12:00:00.000Z",
        },
      ],
      OWNER,
      staleToken,
    );

    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER),
    ).not.toBeNull();
    expect(
      await cache.getCachedDocumentForOwner("current", OWNER),
    ).not.toBeNull();
    expect(
      await cache.getCachedDocumentRecordForOwner("stale-server-row", OWNER),
    ).toBeNull();
  });

  it("returns a dirty cached draft instead of a clean remote snapshot", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        _dirty: true,
        _localUpdatedAt: 200,
        content: "Unsynced local edit",
      }),
    );
    const token = cache.getDocumentCacheWriteToken(OWNER);

    const reconciled = await cache.reconcileCachedDocumentWithServer(
      buildDocument({
        _dirty: false,
        _localUpdatedAt: 100,
        content: "Older server content",
      }),
      token,
    );

    expect(reconciled).toEqual(
      expect.objectContaining({
        _dirty: true,
        _localUpdatedAt: 200,
        content: "Unsynced local edit",
      }),
    );
  });

  it("does not commit remote reconciliation after its write guard is revoked", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        content: "Newer local content",
        _localUpdatedAt: 200,
      }),
    );
    const token = cache.getDocumentCacheWriteToken(OWNER);

    await cache.reconcileCachedDocumentWithServer(
      buildDocument({
        content: "Stale remote content",
        _localUpdatedAt: undefined,
      }),
      token,
      () => false,
    );

    expect(
      await cache.getCachedDocumentForOwner("document-a", OWNER, token),
    ).toEqual(
      expect.objectContaining({
        content: "Newer local content",
        _localUpdatedAt: 200,
      }),
    );
  });

  it("preserves dirty rows that disappear from a server list", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({ id: "dirty", _dirty: true }),
    );
    await cache.putCachedDocument(buildDocument({ id: "clean" }));

    const reconciledDocuments = await cache.syncDocumentList([], OWNER);

    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER),
    ).not.toBeNull();
    expect(
      await cache.getCachedDocumentRecordForOwner("clean", OWNER),
    ).toBeNull();
    expect(reconciledDocuments).toEqual([
      {
        id: "dirty",
        title: "Draft",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
    ]);
  });

  it("returns a dirty local title when the server list contains an older prefix", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        _dirty: true,
        _localUpdatedAt: 200,
        title: "Presentation outline",
      }),
    );

    const reconciledDocuments = await cache.syncDocumentList(
      [
        {
          id: "document-a",
          title: "Present",
          updated_at: "2026-07-17T12:00:00.000Z",
        },
      ],
      OWNER,
    );

    expect(reconciledDocuments).toEqual([
      {
        id: "document-a",
        title: "Presentation outline",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
    ]);
  });

  it("uses fresh server timestamps to order dirty local titles without advancing the cached conflict base", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        _dirty: true,
        _localUpdatedAt: 200,
        title: "Presentation outline",
        updated_at: "2026-07-17T12:00:00.000Z",
      }),
    );

    const reconciledDocuments = await cache.syncDocumentList(
      [
        {
          id: "document-a",
          title: "Present",
          updated_at: "2026-07-17T13:00:00.000Z",
        },
        {
          id: "document-b",
          title: "Second document",
          updated_at: "2026-07-17T12:30:00.000Z",
        },
      ],
      OWNER,
    );

    expect(reconciledDocuments).toEqual([
      {
        id: "document-a",
        title: "Presentation outline",
        updated_at: "2026-07-17T13:00:00.000Z",
      },
      {
        id: "document-b",
        title: "Second document",
        updated_at: "2026-07-17T12:30:00.000Z",
      },
    ]);
    expect(
      await cache.getCachedDocumentForOwner("document-a", OWNER),
    ).toEqual(
      expect.objectContaining({
        _dirty: true,
        _localUpdatedAt: 200,
        title: "Presentation outline",
        updated_at: "2026-07-17T12:00:00.000Z",
      }),
    );
  });

  it("does not let a stale list response roll back a newer completed save", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(
      buildDocument({
        _dirty: false,
        _localUpdatedAt: 200,
        title: "Presentation outline",
        updated_at: "2026-07-17T13:00:00.000Z",
      }),
    );

    const reconciledDocuments = await cache.syncDocumentList(
      [
        {
          id: "document-a",
          title: "Present",
          updated_at: "2026-07-17T12:00:00.000Z",
        },
      ],
      OWNER,
    );

    expect(reconciledDocuments).toEqual([
      {
        id: "document-a",
        title: "Presentation outline",
        updated_at: "2026-07-17T13:00:00.000Z",
      },
    ]);
  });

  it("migrates v2 dirty/non-empty rows as complete and ambiguous empty rows as metadata", async () => {
    await seedPreviousCache([
      buildDocument({ id: "non-empty" }),
      buildDocument({
        id: "dirty-empty",
        content: "",
        _dirty: true,
      }),
      buildDocument({
        id: "clean-empty",
        content: "",
        _dirty: false,
      }),
    ]);

    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);

    expect(
      await cache.getCachedDocumentRecordForOwner("non-empty", OWNER),
    ).toEqual(expect.objectContaining({ kind: "complete" }));
    expect(
      await cache.getCachedDocumentRecordForOwner("dirty-empty", OWNER),
    ).toEqual(
      expect.objectContaining({
        _dirty: true,
        kind: "complete",
      }),
    );
    expect(
      await cache.getCachedDocumentRecordForOwner("clean-empty", OWNER),
    ).toEqual(
      expect.objectContaining({
        id: "clean-empty",
        kind: "metadata",
      }),
    );
    expect(
      await cache.getCachedDocumentForOwner("clean-empty", OWNER),
    ).toBeNull();
    expect(await cache.getDirtyDocuments(OWNER)).toEqual([
      expect.objectContaining({ id: "dirty-empty", _dirtyKey: 1 }),
    ]);
  });

  it("upgrades v3 indexes without rewriting bodies or losing empty complete documents", async () => {
    await seedPreviousCache([
      buildDocument({ id: "dirty", kind: "complete", _dirty: true, _dirtyKey: 1 }),
      buildDocument({ id: "empty", kind: "complete", content: "" }),
      { id: "metadata", kind: "metadata", owner: OWNER, title: "List only",
        updated_at: "2026-07-17T12:00:00.000Z" },
    ], 3);
    const cache = await loadDocumentCache();
    const openCursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    await cache.activateDocumentCacheForOwner(OWNER);

    expect(openCursor).not.toHaveBeenCalled();
    expect(await cache.getDirtyDocuments(OWNER)).toEqual([
      expect.objectContaining({ id: "dirty", _dirty: true }),
    ]);
    expect(await cache.getCachedDocumentForOwner("empty", OWNER)).toEqual(
      expect.objectContaining({ kind: "complete", content: "" }),
    );
    expect(await cache.getCachedDocumentForOwner("metadata", OWNER)).toBeNull();
  });

  it("keeps cache activation best-effort while an older tab blocks the upgrade", async () => {
    await seedPreviousCache([
      buildDocument({ kind: "complete", _dirty: true, _dirtyKey: 1 }),
    ], 3);
    // The shipped v3 connection has no versionchange handler to close it.
    const legacyDatabase = await waitForRequest(indexedDB.open("mushpot", 3));
    const cache = await loadDocumentCache();
    let deadline: ReturnType<typeof setTimeout> | undefined;

    try {
      await cache.activateDocumentCacheForOwner(OWNER);
      expect(cache.getDocumentCacheWriteToken(OWNER)).toBeNull();

      const repeatedActivation = cache.activateDocumentCacheForOwner(OWNER);
      const settled = await Promise.race([
        repeatedActivation.then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 100);
        }),
      ]);
      // A queued second open never emits blocked, so it would prevent the
      // document loaders from falling back to their completed remote request.
      expect(settled).toBe(true);
      expect(cache.getDocumentCacheWriteToken(OWNER)).toBeNull();
    } finally {
      clearTimeout(deadline);
      legacyDatabase.close();
    }

    // This request runs after the pending upgrade and confirms it has finished.
    const upgradedDatabase = await waitForRequest(indexedDB.open("mushpot", 4));
    upgradedDatabase.close();
    await cache.activateDocumentCacheForOwner(OWNER);
    expect(cache.getDocumentCacheWriteToken(OWNER)).not.toBeNull();
    expect(await cache.getDirtyDocuments(OWNER)).toEqual([
      expect.objectContaining({ id: "document-a", _dirty: true }),
    ]);
  });
});
