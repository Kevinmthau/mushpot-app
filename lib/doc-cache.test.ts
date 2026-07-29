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

describe("owner-scoped document cache writes", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(globalThis, {
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    });
  });

  it("rejects writes until the authenticated owner is activated", async () => {
    const cache = await loadDocumentCache();
    await cache.setLastActiveOwner(OWNER);

    await cache.putCachedDocument(buildDocument());

    expect(await cache.getCachedDocument("document-a")).toBeNull();
  });

  it("preserves offline writes for an active owner", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);

    await cache.putCachedDocument(buildDocument({ _dirty: true }));

    expect(await cache.getCachedDocumentForOwner("document-a", OWNER)).toEqual(
      expect.objectContaining({
        _dirty: true,
        content: "Private content",
        owner: OWNER,
      }),
    );
  });

  it("atomically tombstones an owner so a concurrent old write cannot survive", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const oldWriteToken = cache.getDocumentCacheWriteToken(OWNER);

    const queuedWrite = cache.putCachedDocument(
      buildDocument(),
      oldWriteToken,
    );
    const purge = cache.clearCachedDocumentsForOwner(OWNER);
    await Promise.all([queuedWrite, purge]);

    expect(await cache.getCachedDocument("document-a")).toBeNull();
    expect(cache.getDocumentCacheWriteToken(OWNER)).toBeNull();
  });

  it("lets a purge win over authenticated activation that started first", async () => {
    const cache = await loadDocumentCache();

    const activation = cache.activateDocumentCacheForOwner(OWNER);
    const purge = cache.clearCachedDocumentsForOwner(OWNER);
    await Promise.all([activation, purge]);

    expect(cache.getDocumentCacheWriteToken(OWNER)).toBeNull();
    await cache.putCachedDocument(buildDocument());
    expect(await cache.getCachedDocument("document-a")).toBeNull();
  });

  it("rejects an old generation even after the same owner is reactivated", async () => {
    const cache = await loadDocumentCache();
    await cache.activateDocumentCacheForOwner(OWNER);
    const oldWriteToken = cache.getDocumentCacheWriteToken(OWNER);

    await cache.clearCachedDocumentsForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(OWNER);
    const currentWriteToken = cache.getDocumentCacheWriteToken(OWNER);

    expect(oldWriteToken).not.toBeNull();
    expect(currentWriteToken).not.toBeNull();
    expect(currentWriteToken?.generation).not.toBe(oldWriteToken?.generation);

    await cache.putCachedDocument(buildDocument(), oldWriteToken);
    expect(await cache.getCachedDocument("document-a")).toBeNull();

    await cache.putCachedDocument(buildDocument(), currentWriteToken);
    expect(await cache.getCachedDocument("document-a")).not.toBeNull();
  });

  it("keeps another authenticated owner's cache active during a purge", async () => {
    const cache = await loadDocumentCache();
    const otherOwner = "owner-b";
    await cache.activateDocumentCacheForOwner(OWNER);
    await cache.activateDocumentCacheForOwner(otherOwner);
    await cache.putCachedDocument(buildDocument());
    await cache.putCachedDocument(
      buildDocument({ id: "document-b", owner: otherOwner }),
    );

    await cache.clearCachedDocumentsForOwner(OWNER);

    expect(await cache.getCachedDocument("document-a")).toBeNull();
    expect(
      await cache.getCachedDocumentForOwner("document-b", otherOwner),
    ).not.toBeNull();
  });
});
