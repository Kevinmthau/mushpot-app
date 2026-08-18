import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CachedDocument } from "@/lib/doc-cache";

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

async function seedVersionTwoCache(documents: CachedDocument[]) {
  const openRequest = indexedDB.open("mushpot", 2);
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

  it("updates list metadata without discarding complete cached content", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.putCachedDocument(buildDocument());

    await cache.syncDocumentList(
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
        title: "Renamed remotely",
        updated_at: "2026-07-19T12:00:00.000Z",
      }),
    );
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

    await cache.syncDocumentList(
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

    await cache.syncDocumentList([], OWNER);

    expect(
      await cache.getCachedDocumentForOwner("dirty", OWNER),
    ).not.toBeNull();
    expect(
      await cache.getCachedDocumentRecordForOwner("clean", OWNER),
    ).toBeNull();
  });

  it("migrates v2 dirty/non-empty rows as complete and ambiguous empty rows as metadata", async () => {
    await seedVersionTwoCache([
      buildDocument({ id: "non-empty" }),
      buildDocument({
        id: "dirty-empty",
        content: "",
        _dirty: true,
        _dirtyKey: 1,
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
  });
});
